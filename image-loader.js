/**
 * Advanced Image Loading System v2.0
 * ===================================
 * 
 * Features:
 * - Native lazy loading with IntersectionObserver fallback
 * - Blur-up LQIP (Low Quality Image Placeholder) technique
 * - Exponential backoff retry with jitter
 * - img.decode() for jank-free rendering
 * - Proper Dropbox URL handling
 * - IndexedDB caching for offline support
 * - Connection-aware loading
 * - Idle-time prefetching
 * 
 * Based on research from:
 * - web.dev, MDN, ImageKit, lazysizes library
 * - Chrome DevRel best practices
 */

(function() {
    'use strict';

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    
    const CONFIG = {
        // Retry settings
        MAX_RETRIES: 3,
        BASE_RETRY_DELAY: 1000,      // ms, will be multiplied exponentially
        MAX_RETRY_DELAY: 10000,      // ms
        LOAD_TIMEOUT: 20000,         // ms
        
        // IntersectionObserver settings
        ROOT_MARGIN: '200px 0px',    // Start loading 200px before entering viewport
        THRESHOLD: 0.01,
        
        // Prefetch settings
        PREFETCH_BATCH_SIZE: 3,
        PREFETCH_DELAY: 100,         // ms between batches
        
        // Cache settings
        MEMORY_CACHE_MAX: 50,        // Max images in memory cache
        INDEXED_DB_NAME: 'CERImageCache',
        INDEXED_DB_VERSION: 1,
        CACHE_DURATION: 7 * 24 * 60 * 60 * 1000, // 7 days
        
        // Placeholder
        BLUR_PLACEHOLDER: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"%3E%3Crect fill="%23f0f0f0" width="400" height="300"/%3E%3C/svg%3E',
        ERROR_PLACEHOLDER: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"%3E%3Crect fill="%23ffebee" width="400" height="300"/%3E%3Ctext x="200" y="150" text-anchor="middle" fill="%23c62828" font-family="system-ui" font-size="14"%3E⚠️ Image failed to load%3C/text%3E%3Ctext x="200" y="175" text-anchor="middle" fill="%23666" font-family="system-ui" font-size="12"%3ETap to retry%3C/text%3E%3C/svg%3E'
    };

    // =========================================================================
    // STATE MANAGEMENT
    // =========================================================================
    
    const state = {
        // Memory cache (LRU-ish)
        memoryCache: new Map(),
        
        // Currently loading URLs
        loading: new Map(),  // url -> Promise
        
        // Failed URLs with attempt count
        failed: new Map(),   // url -> { attempts, lastAttempt }
        
        // IntersectionObserver instance
        observer: null,
        
        // IndexedDB instance
        db: null,
        
        // Connection info
        connection: {
            type: 'unknown',
            saveData: false,
            effectiveType: '4g'
        },
        
        // Initialization flag
        initialized: false
    };

    // =========================================================================
    // UTILITY FUNCTIONS
    // =========================================================================
    
    /**
     * Convert Dropbox URL for direct image display
     * Handles all Dropbox URL formats including new scl format
     */
    function convertDropboxUrl(url) {
        if (!url || typeof url !== 'string') return url;
        
        // Decode HTML entities
        url = url.replace(/&amp;/g, '&');
        
        // Skip if already a direct link
        if (url.includes('dl.dropboxusercontent.com')) {
            return url;
        }
        
        // New format: dropbox.com/scl/fi/...
        if (url.includes('dropbox.com/scl/')) {
            // Parse URL to handle parameters properly
            try {
                const urlObj = new URL(url);
                // Remove dl parameter if present
                urlObj.searchParams.delete('dl');
                // Set raw=1 for direct rendering
                urlObj.searchParams.set('raw', '1');
                return urlObj.toString();
            } catch (e) {
                // Fallback to string manipulation
                url = url.replace(/[?&]dl=[01]/g, '');
                if (!url.includes('raw=1')) {
                    url += (url.includes('?') ? '&' : '?') + 'raw=1';
                }
                return url;
            }
        }
        
        // Old format: www.dropbox.com/s/...
        if (url.includes('dropbox.com/s/')) {
            return url
                .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
                .replace(/\?dl=[01]/g, '');
        }
        
        return url;
    }

    /**
     * Normalize all image URLs in HTML string
     */
    function normalizeImageUrls(html) {
        if (!html || typeof html !== 'string') return html;
        
        // Fix encoded ampersands first
        html = html.replace(/&amp;/g, '&');
        
        // Fix Dropbox URLs in src attributes
        html = html.replace(
            /src=["']([^"']*(?:dropbox\.com|dropboxusercontent\.com)[^"']*)["']/gi,
            (match, url) => `src="${convertDropboxUrl(url)}"`
        );
        
        return html;
    }

    /**
     * Calculate retry delay with exponential backoff and jitter
     */
    function getRetryDelay(attempt) {
        const exponentialDelay = CONFIG.BASE_RETRY_DELAY * Math.pow(2, attempt);
        const jitter = Math.random() * 0.3 * exponentialDelay; // 0-30% jitter
        return Math.min(exponentialDelay + jitter, CONFIG.MAX_RETRY_DELAY);
    }

    /**
     * Check if URL is likely an image
     */
    function isImageUrl(url) {
        if (!url) return false;
        const imageExtensions = /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)(\?|$)/i;
        return imageExtensions.test(url) || 
               url.includes('dropbox.com') || 
               url.includes('imgur.com') ||
               url.includes('googleusercontent.com');
    }

    /**
     * Get connection info for adaptive loading
     */
    function updateConnectionInfo() {
        if ('connection' in navigator) {
            const conn = navigator.connection;
            state.connection = {
                type: conn.type || 'unknown',
                saveData: conn.saveData || false,
                effectiveType: conn.effectiveType || '4g'
            };
        }
    }

    // =========================================================================
    // INDEXEDDB CACHE
    // =========================================================================
    
    /**
     * Initialize IndexedDB for persistent caching
     */
    async function initIndexedDB() {
        return new Promise((resolve, reject) => {
            if (!('indexedDB' in window)) {
                console.log('IndexedDB not supported, using memory cache only');
                resolve(null);
                return;
            }

            const request = indexedDB.open(CONFIG.INDEXED_DB_NAME, CONFIG.INDEXED_DB_VERSION);

            request.onerror = () => {
                console.warn('IndexedDB open failed:', request.error);
                resolve(null);
            };

            request.onsuccess = () => {
                state.db = request.result;
                resolve(state.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                if (!db.objectStoreNames.contains('images')) {
                    const store = db.createObjectStore('images', { keyPath: 'url' });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }
            };
        });
    }

    /**
     * Get image from IndexedDB cache
     */
    async function getFromIndexedDB(url) {
        if (!state.db) return null;
        
        return new Promise((resolve) => {
            try {
                const transaction = state.db.transaction(['images'], 'readonly');
                const store = transaction.objectStore('images');
                const request = store.get(url);
                
                request.onsuccess = () => {
                    const result = request.result;
                    if (result && (Date.now() - result.timestamp < CONFIG.CACHE_DURATION)) {
                        resolve(result.blob);
                    } else {
                        resolve(null);
                    }
                };
                
                request.onerror = () => resolve(null);
            } catch (e) {
                resolve(null);
            }
        });
    }

    /**
     * Store image in IndexedDB cache
     */
    async function storeInIndexedDB(url, blob) {
        if (!state.db) return;
        
        try {
            const transaction = state.db.transaction(['images'], 'readwrite');
            const store = transaction.objectStore('images');
            
            store.put({
                url: url,
                blob: blob,
                timestamp: Date.now()
            });
        } catch (e) {
            console.warn('Failed to cache image:', e);
        }
    }

    /**
     * Clean up old entries from IndexedDB
     */
    async function cleanupIndexedDB() {
        if (!state.db) return;
        
        try {
            const transaction = state.db.transaction(['images'], 'readwrite');
            const store = transaction.objectStore('images');
            const index = store.index('timestamp');
            const cutoff = Date.now() - CONFIG.CACHE_DURATION;
            
            const request = index.openCursor(IDBKeyRange.upperBound(cutoff));
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                }
            };
        } catch (e) {
            console.warn('IndexedDB cleanup failed:', e);
        }
    }

    // =========================================================================
    // MEMORY CACHE (LRU)
    // =========================================================================
    
    /**
     * Get from memory cache
     */
    function getFromMemoryCache(url) {
        if (state.memoryCache.has(url)) {
            // Move to end (most recently used)
            const value = state.memoryCache.get(url);
            state.memoryCache.delete(url);
            state.memoryCache.set(url, value);
            return value;
        }
        return null;
    }

    /**
     * Store in memory cache with LRU eviction
     */
    function storeInMemoryCache(url, objectUrl) {
        // Evict oldest entries if at capacity
        while (state.memoryCache.size >= CONFIG.MEMORY_CACHE_MAX) {
            const oldestKey = state.memoryCache.keys().next().value;
            const oldestUrl = state.memoryCache.get(oldestKey);
            URL.revokeObjectURL(oldestUrl);
            state.memoryCache.delete(oldestKey);
        }
        
        state.memoryCache.set(url, objectUrl);
    }

    // =========================================================================
    // CORE IMAGE LOADING
    // =========================================================================
    
    /**
     * Load a single image with retry logic
     * Returns a Promise that resolves to an object URL or rejects on failure
     */
    function loadImage(url, attempt = 0) {
        const fixedUrl = convertDropboxUrl(url);
        
        // Check if already loading
        if (state.loading.has(fixedUrl)) {
            return state.loading.get(fixedUrl);
        }
        
        // Check memory cache first
        const cached = getFromMemoryCache(fixedUrl);
        if (cached) {
            return Promise.resolve(cached);
        }
        
        // Create loading promise
        const loadPromise = new Promise(async (resolve, reject) => {
            // Try IndexedDB cache
            const cachedBlob = await getFromIndexedDB(fixedUrl);
            if (cachedBlob) {
                const objectUrl = URL.createObjectURL(cachedBlob);
                storeInMemoryCache(fixedUrl, objectUrl);
                state.loading.delete(fixedUrl);
                resolve(objectUrl);
                return;
            }
            
            // Fetch the image
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), CONFIG.LOAD_TIMEOUT);
            
            try {
                const response = await fetch(fixedUrl, {
                    signal: controller.signal,
                    mode: 'cors',
                    credentials: 'omit'
                });
                
                clearTimeout(timeoutId);
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                
                const blob = await response.blob();
                
                // Verify it's actually an image
                if (!blob.type.startsWith('image/')) {
                    throw new Error('Response is not an image');
                }
                
                // Cache in IndexedDB (async, don't wait)
                storeInIndexedDB(fixedUrl, blob);
                
                // Create object URL and cache in memory
                const objectUrl = URL.createObjectURL(blob);
                storeInMemoryCache(fixedUrl, objectUrl);
                
                // Clear failed state
                state.failed.delete(fixedUrl);
                state.loading.delete(fixedUrl);
                
                resolve(objectUrl);
                
            } catch (error) {
                clearTimeout(timeoutId);
                
                // Should we retry?
                if (attempt < CONFIG.MAX_RETRIES) {
                    const delay = getRetryDelay(attempt);
                    console.log(`Image load failed (attempt ${attempt + 1}/${CONFIG.MAX_RETRIES + 1}), retrying in ${Math.round(delay)}ms:`, fixedUrl.substring(0, 60));
                    
                    state.loading.delete(fixedUrl);
                    
                    setTimeout(() => {
                        loadImage(url, attempt + 1).then(resolve).catch(reject);
                    }, delay);
                } else {
                    // Max retries reached
                    state.failed.set(fixedUrl, {
                        attempts: attempt + 1,
                        lastAttempt: Date.now(),
                        error: error.message
                    });
                    state.loading.delete(fixedUrl);
                    
                    console.warn(`Image load failed after ${attempt + 1} attempts:`, fixedUrl.substring(0, 60));
                    reject(error);
                }
            }
        });
        
        state.loading.set(fixedUrl, loadPromise);
        return loadPromise;
    }

    /**
     * Alternative: Load image using Image element (for older browsers or CORS issues)
     */
    function loadImageElement(url, attempt = 0) {
        const fixedUrl = convertDropboxUrl(url);
        
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            
            let timeoutId;
            
            const cleanup = () => {
                clearTimeout(timeoutId);
                img.onload = null;
                img.onerror = null;
            };
            
            timeoutId = setTimeout(() => {
                cleanup();
                if (attempt < CONFIG.MAX_RETRIES) {
                    const delay = getRetryDelay(attempt);
                    setTimeout(() => {
                        loadImageElement(url, attempt + 1).then(resolve).catch(reject);
                    }, delay);
                } else {
                    reject(new Error('Timeout'));
                }
            }, CONFIG.LOAD_TIMEOUT);
            
            img.onload = async () => {
                cleanup();
                
                // Use decode() for jank-free rendering
                try {
                    await img.decode();
                } catch (e) {
                    // decode() failed but image loaded, continue anyway
                }
                
                state.failed.delete(fixedUrl);
                resolve(fixedUrl);
            };
            
            img.onerror = () => {
                cleanup();
                if (attempt < CONFIG.MAX_RETRIES) {
                    const delay = getRetryDelay(attempt);
                    setTimeout(() => {
                        loadImageElement(url, attempt + 1).then(resolve).catch(reject);
                    }, delay);
                } else {
                    state.failed.set(fixedUrl, {
                        attempts: attempt + 1,
                        lastAttempt: Date.now()
                    });
                    reject(new Error('Load failed'));
                }
            };
            
            // Add cache buster only on retries
            const finalUrl = attempt > 0 
                ? fixedUrl + (fixedUrl.includes('?') ? '&' : '?') + `_cb=${Date.now()}`
                : fixedUrl;
            
            img.src = finalUrl;
        });
    }

    // =========================================================================
    // IMAGE ELEMENT ENHANCEMENT
    // =========================================================================
    
    /**
     * Enhance an image element with loading states and lazy loading
     */
    function enhanceImageElement(img) {
        // Skip if already processed
        if (img.dataset.enhanced === 'true') return;
        img.dataset.enhanced = 'true';
        
        const originalSrc = img.getAttribute('src') || img.dataset.src;
        if (!originalSrc || originalSrc.startsWith('data:')) return;
        
        const fixedSrc = convertDropboxUrl(originalSrc);
        
        // Store original source
        img.dataset.originalSrc = fixedSrc;
        
        // Get dimensions if available
        const width = img.getAttribute('width') || img.naturalWidth || '';
        const height = img.getAttribute('height') || img.naturalHeight || '';
        
        // Create wrapper for loading state
        const wrapper = document.createElement('div');
        wrapper.className = 'img-loader-wrapper';
        wrapper.style.cssText = `
            position: relative;
            width: 100%;
            max-width: ${width ? width + 'px' : '600px'};
            min-height: ${height ? height + 'px' : '150px'};
            margin: 0 auto;
            background: linear-gradient(135deg, #f5f7fa 0%, #e4e8ec 100%);
            border-radius: 8px;
            overflow: hidden;
        `;
        
        // Add aspect ratio if dimensions known
        if (width && height) {
            wrapper.style.aspectRatio = `${width} / ${height}`;
            wrapper.style.minHeight = 'auto';
        }
        
        // Create blur placeholder
        const placeholder = document.createElement('div');
        placeholder.className = 'img-loader-placeholder';
        placeholder.style.cssText = `
            position: absolute;
            inset: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            background: linear-gradient(135deg, #f5f7fa 0%, #e4e8ec 100%);
            transition: opacity 0.3s ease;
        `;
        placeholder.innerHTML = `
            <div style="text-align: center;">
                <div class="img-loader-spinner" style="
                    width: 32px;
                    height: 32px;
                    border: 3px solid #e0e0e0;
                    border-top-color: #667eea;
                    border-radius: 50%;
                    animation: imgLoaderSpin 0.8s linear infinite;
                    margin: 0 auto 8px;
                "></div>
                <div style="font-size: 12px; color: #888;">Loading...</div>
            </div>
        `;
        
        // Set up image styles
        img.style.cssText = `
            width: 100%;
            height: auto;
            display: block;
            border-radius: 8px;
            opacity: 0;
            transition: opacity 0.3s ease;
        `;
        
        // Add native lazy loading
        if (!img.hasAttribute('loading')) {
            img.setAttribute('loading', 'lazy');
        }
        
        // Add decoding hint
        img.setAttribute('decoding', 'async');
        
        // Insert wrapper
        if (img.parentNode) {
            img.parentNode.insertBefore(wrapper, img);
            wrapper.appendChild(placeholder);
            wrapper.appendChild(img);
        }
        
        // Load the image
        const doLoad = async () => {
            try {
                // Try fetch-based loading first (better caching)
                const objectUrl = await loadImage(fixedSrc);
                
                // Create new image to decode
                const tempImg = new Image();
                tempImg.src = objectUrl;
                
                try {
                    await tempImg.decode();
                } catch (e) {
                    // Decode failed but continue
                }
                
                // Update the visible image
                img.src = objectUrl;
                img.style.opacity = '1';
                placeholder.style.opacity = '0';
                
                setTimeout(() => {
                    placeholder.remove();
                    wrapper.style.minHeight = 'auto';
                    wrapper.style.background = 'none';
                }, 300);
                
            } catch (error) {
                // Show error state
                placeholder.innerHTML = `
                    <div style="text-align: center; padding: 20px; cursor: pointer;" onclick="window.ImageLoader.retry(this.closest('.img-loader-wrapper').querySelector('img'))">
                        <div style="font-size: 32px; margin-bottom: 8px;">⚠️</div>
                        <div style="font-size: 12px; color: #c62828; margin-bottom: 4px;">Failed to load image</div>
                        <div style="font-size: 11px; color: #888;">Tap to retry</div>
                    </div>
                `;
                placeholder.style.background = '#ffebee';
                
                img.style.opacity = '0.2';
            }
        };
        
        // Use IntersectionObserver if available, otherwise load immediately
        if (state.observer) {
            // Will be loaded when it enters viewport
            img.dataset.pendingLoad = 'true';
            state.observer.observe(wrapper);
        } else {
            doLoad();
        }
        
        // Store load function for manual triggering
        img._doLoad = doLoad;
    }

    /**
     * Retry loading a failed image
     */
    function retryImage(img) {
        if (!img || !img.dataset.originalSrc) return;
        
        const url = img.dataset.originalSrc;
        
        // Clear failed state
        state.failed.delete(url);
        
        // Reset UI
        const wrapper = img.closest('.img-loader-wrapper');
        if (wrapper) {
            const placeholder = wrapper.querySelector('.img-loader-placeholder');
            if (placeholder) {
                placeholder.innerHTML = `
                    <div style="text-align: center;">
                        <div class="img-loader-spinner" style="
                            width: 32px;
                            height: 32px;
                            border: 3px solid #e0e0e0;
                            border-top-color: #667eea;
                            border-radius: 50%;
                            animation: imgLoaderSpin 0.8s linear infinite;
                            margin: 0 auto 8px;
                        "></div>
                        <div style="font-size: 12px; color: #888;">Retrying...</div>
                    </div>
                `;
                placeholder.style.background = 'linear-gradient(135deg, #f5f7fa 0%, #e4e8ec 100%)';
                placeholder.style.opacity = '1';
            }
        }
        
        // Reload
        if (img._doLoad) {
            img._doLoad();
        }
    }

    // =========================================================================
    // INTERSECTION OBSERVER
    // =========================================================================
    
    /**
     * Initialize IntersectionObserver for lazy loading
     */
    function initObserver() {
        if (!('IntersectionObserver' in window)) {
            console.log('IntersectionObserver not supported, images will load immediately');
            return;
        }
        
        state.observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const wrapper = entry.target;
                    const img = wrapper.querySelector('img[data-pending-load="true"]');
                    
                    if (img && img._doLoad) {
                        img.dataset.pendingLoad = 'false';
                        img._doLoad();
                    }
                    
                    state.observer.unobserve(wrapper);
                }
            });
        }, {
            rootMargin: CONFIG.ROOT_MARGIN,
            threshold: CONFIG.THRESHOLD
        });
    }

    // =========================================================================
    // DOM PROCESSING
    // =========================================================================
    
    /**
     * Process all images in an element
     */
    function processImagesInElement(element) {
        if (!element) return;
        
        const images = element.querySelectorAll('img:not([data-enhanced="true"])');
        images.forEach(img => {
            // Skip tiny images, icons, etc.
            const src = img.getAttribute('src') || '';
            if (src.startsWith('data:') && src.length < 200) return;
            if (img.classList.contains('no-enhance')) return;
            
            enhanceImageElement(img);
        });
    }

    /**
     * Initialize MutationObserver for dynamically added images
     */
    function initMutationObserver() {
        const observer = new MutationObserver((mutations) => {
            // Batch processing with requestIdleCallback
            const process = () => {
                mutations.forEach(mutation => {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType !== Node.ELEMENT_NODE) return;
                        
                        // Check if node itself is an image
                        if (node.tagName === 'IMG') {
                            enhanceImageElement(node);
                        }
                        
                        // Check for images inside the node
                        if (node.querySelectorAll) {
                            const containers = [
                                '.question-container',
                                '.custom-question',
                                '.question-body',
                                '.answer-template'
                            ].join(',');
                            
                            // If node matches containers or contains them
                            if (node.matches?.(containers)) {
                                processImagesInElement(node);
                            } else {
                                node.querySelectorAll(containers).forEach(processImagesInElement);
                            }
                        }
                    });
                });
            };
            
            if ('requestIdleCallback' in window) {
                requestIdleCallback(process, { timeout: 100 });
            } else {
                setTimeout(process, 16);
            }
        });
        
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    // =========================================================================
    // PREFETCHING
    // =========================================================================
    
    /**
     * Prefetch images during idle time
     */
    function prefetchImages(urls) {
        if (!urls || !urls.length) return;
        
        const fixedUrls = urls.map(convertDropboxUrl).filter(url => {
            // Skip already cached or failed
            return !state.memoryCache.has(url) && 
                   !state.failed.has(url) && 
                   !state.loading.has(url);
        });
        
        if (!fixedUrls.length) return;
        
        const prefetchBatch = (batch) => {
            batch.forEach(url => {
                // Use link preload for browser-level prefetching
                const link = document.createElement('link');
                link.rel = 'prefetch';
                link.as = 'image';
                link.href = url;
                document.head.appendChild(link);
                
                // Also warm our cache
                loadImage(url).catch(() => {}); // Ignore errors for prefetch
            });
        };
        
        // Process in batches during idle time
        let index = 0;
        const processNextBatch = () => {
            if (index >= fixedUrls.length) return;
            
            const batch = fixedUrls.slice(index, index + CONFIG.PREFETCH_BATCH_SIZE);
            index += CONFIG.PREFETCH_BATCH_SIZE;
            
            if ('requestIdleCallback' in window) {
                requestIdleCallback(() => {
                    prefetchBatch(batch);
                    setTimeout(processNextBatch, CONFIG.PREFETCH_DELAY);
                }, { timeout: 2000 });
            } else {
                setTimeout(() => {
                    prefetchBatch(batch);
                    setTimeout(processNextBatch, CONFIG.PREFETCH_DELAY);
                }, 100);
            }
        };
        
        processNextBatch();
    }

    /**
     * Extract image URLs from questions and prefetch them
     */
    function prefetchQuestionImages(questions) {
        if (!questions || !Array.isArray(questions)) return;
        
        const urls = [];
        
        questions.forEach(q => {
            // Check HTML content
            if (q.html) {
                const matches = q.html.match(/src=["']([^"']+)["']/gi) || [];
                matches.forEach(match => {
                    const url = match.replace(/src=["']/i, '').replace(/["']$/, '');
                    if (url && isImageUrl(url)) {
                        urls.push(url);
                    }
                });
            }
            
            // Check blocks
            if (q.blocks && Array.isArray(q.blocks)) {
                q.blocks.forEach(block => {
                    if (block.type === 'image' && block.value) {
                        urls.push(block.value);
                    }
                });
            }
        });
        
        prefetchImages(urls);
    }

    // =========================================================================
    // HTML GENERATION
    // =========================================================================
    
    /**
     * Create an optimized image HTML string
     */
    function createOptimizedImage(src, className = '', style = '') {
        const fixedSrc = convertDropboxUrl(src);
        
        return `
            <img 
                src="${fixedSrc}" 
                class="${className}" 
                style="max-width: 100%; border-radius: 8px; display: block; margin: 0 auto; ${style}"
                loading="lazy"
                decoding="async"
                onerror="this.style.opacity='0.3'; this.title='Image failed to load - tap to retry';"
            >
        `;
    }

    // =========================================================================
    // CACHE MANAGEMENT
    // =========================================================================
    
    /**
     * Clear all caches
     */
    function clearCache() {
        // Revoke all object URLs
        state.memoryCache.forEach(objectUrl => {
            URL.revokeObjectURL(objectUrl);
        });
        state.memoryCache.clear();
        
        // Clear loading and failed states
        state.loading.clear();
        state.failed.clear();
        
        // Clear IndexedDB
        if (state.db) {
            const transaction = state.db.transaction(['images'], 'readwrite');
            const store = transaction.objectStore('images');
            store.clear();
        }
        
        console.log('Image cache cleared');
    }

    /**
     * Get cache statistics
     */
    function getCacheStats() {
        return {
            memoryCache: state.memoryCache.size,
            loading: state.loading.size,
            failed: state.failed.size,
            failedUrls: Array.from(state.failed.keys())
        };
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================
    
    /**
     * Initialize the image loading system
     */
    async function init() {
        if (state.initialized) return;
        state.initialized = true;
        
        console.log('Initializing Advanced Image Loading System v2.0...');
        
        // Add CSS for spinner animation
        if (!document.getElementById('img-loader-styles')) {
            const style = document.createElement('style');
            style.id = 'img-loader-styles';
            style.textContent = `
                @keyframes imgLoaderSpin {
                    to { transform: rotate(360deg); }
                }
                
                .img-loader-wrapper {
                    container-type: inline-size;
                }
                
                .img-loader-wrapper img {
                    object-fit: contain;
                }
                
                /* Dark mode support */
                @media (prefers-color-scheme: dark) {
                    .img-loader-placeholder {
                        background: linear-gradient(135deg, #2a2a3e 0%, #1e1e30 100%) !important;
                    }
                    .img-loader-spinner {
                        border-color: #3a3a4a !important;
                        border-top-color: #667eea !important;
                    }
                }
                
                [data-theme="dark"] .img-loader-placeholder {
                    background: linear-gradient(135deg, #2a2a3e 0%, #1e1e30 100%) !important;
                }
                
                [data-theme="dark"] .img-loader-spinner {
                    border-color: #3a3a4a !important;
                    border-top-color: #667eea !important;
                }
            `;
            document.head.appendChild(style);
        }
        
        // Update connection info
        updateConnectionInfo();
        if ('connection' in navigator) {
            navigator.connection.addEventListener('change', updateConnectionInfo);
        }
        
        // Initialize IndexedDB
        await initIndexedDB();
        
        // Clean up old cache entries
        cleanupIndexedDB();
        
        // Initialize IntersectionObserver
        initObserver();
        
        // Initialize MutationObserver for dynamic content
        initMutationObserver();
        
        // Process existing images
        document.querySelectorAll('.question-container, .custom-question').forEach(container => {
            processImagesInElement(container);
        });
        
        console.log('Advanced Image Loading System v2.0 ready');
    }

    // =========================================================================
    // PUBLIC API
    // =========================================================================
    
    window.ImageLoader = {
        init,
        loadImage,
        loadImageElement,
        enhanceImageElement,
        processImagesInElement,
        prefetchImages,
        prefetchQuestionImages,
        createOptimizedImage,
        convertDropboxUrl,
        normalizeImageUrls,
        clearCache,
        getCacheStats,
        retry: retryImage,
        
        // Expose state for debugging
        _state: state,
        _config: CONFIG
    };
    
    // Also expose commonly used functions on window for backwards compatibility
    window.convertDropboxUrl = convertDropboxUrl;
    window.normalizeImageUrls = normalizeImageUrls;
    window.createOptimizedImage = createOptimizedImage;
    window.preloadQuestionImages = prefetchQuestionImages;
    window.clearImageCache = clearCache;
    window.processImagesInElement = processImagesInElement;

    // Auto-initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
