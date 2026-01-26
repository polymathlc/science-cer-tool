/**
 * Improved Image Loading System
 * Fixes: images not loading, requiring login/logout, multiple refreshes
 */

(function() {
    'use strict';

    // Configuration
    const CONFIG = {
        MAX_RETRIES: 3,
        RETRY_DELAY: 1000,
        LOAD_TIMEOUT: 15000,
        PRELOAD_BATCH_SIZE: 5,
        CACHE_DURATION: 30 * 60 * 1000 // 30 minutes
    };

    // Image cache with timestamps
    window.imageCache = window.imageCache || new Map();
    window.loadingImages = window.loadingImages || new Set();
    window.failedImages = window.failedImages || new Map();

    /**
     * Convert Dropbox URL for direct image display
     * Handles all Dropbox URL formats
     */
    window.convertDropboxUrl = function(url) {
        if (!url) return url;

        // Decode HTML entities
        url = url.replace(/&amp;/g, '&');

        // Already a direct link
        if (url.includes('dl.dropboxusercontent.com')) {
            return url;
        }

        // New format: dropbox.com/scl/fi/...
        if (url.includes('dropbox.com/scl/')) {
            // Remove any existing dl parameter
            url = url.replace(/[?&]dl=[01]/g, '');
            // Add raw=1 if not present
            if (!url.includes('raw=1')) {
                url += (url.includes('?') ? '&' : '?') + 'raw=1';
            }
            return url;
        }

        // Old format: www.dropbox.com/s/...
        if (url.includes('dropbox.com/s/')) {
            return url.replace('www.dropbox.com', 'dl.dropboxusercontent.com')
                      .replace(/\?dl=[01]/g, '');
        }

        return url;
    };

    /**
     * Normalize all image URLs in HTML string
     */
    window.normalizeImageUrls = function(html) {
        if (!html) return html;

        // Fix encoded ampersands
        html = html.replace(/&amp;/g, '&');

        // Fix Dropbox URLs in src attributes
        html = html.replace(/src=["']([^"']*dropbox\.com[^"']*)["']/gi, (match, url) => {
            return 'src="' + window.convertDropboxUrl(url) + '"';
        });

        return html;
    };

    /**
     * Load an image with retry logic and timeout
     */
    window.loadImageWithRetry = function(url, retries = CONFIG.MAX_RETRIES) {
        return new Promise((resolve, reject) => {
            // Check cache first
            const cached = window.imageCache.get(url);
            if (cached && (Date.now() - cached.timestamp < CONFIG.CACHE_DURATION)) {
                resolve(cached.img);
                return;
            }

            // Already loading this image
            if (window.loadingImages.has(url)) {
                // Wait for it to complete
                const checkInterval = setInterval(() => {
                    if (!window.loadingImages.has(url)) {
                        clearInterval(checkInterval);
                        const cached = window.imageCache.get(url);
                        if (cached) {
                            resolve(cached.img);
                        } else {
                            reject(new Error('Image load failed'));
                        }
                    }
                }, 100);
                return;
            }

            window.loadingImages.add(url);

            const attemptLoad = (attemptsLeft) => {
                const img = new Image();
                let timeoutId;

                const cleanup = () => {
                    clearTimeout(timeoutId);
                    img.onload = null;
                    img.onerror = null;
                };

                timeoutId = setTimeout(() => {
                    cleanup();
                    if (attemptsLeft > 1) {
                        console.log(`Image timeout, retrying... (${attemptsLeft - 1} left): ${url.substring(0, 50)}...`);
                        setTimeout(() => attemptLoad(attemptsLeft - 1), CONFIG.RETRY_DELAY);
                    } else {
                        window.loadingImages.delete(url);
                        window.failedImages.set(url, Date.now());
                        reject(new Error('Image load timeout'));
                    }
                }, CONFIG.LOAD_TIMEOUT);

                img.onload = () => {
                    cleanup();
                    window.loadingImages.delete(url);
                    window.imageCache.set(url, { img, timestamp: Date.now() });
                    window.failedImages.delete(url);
                    resolve(img);
                };

                img.onerror = () => {
                    cleanup();
                    if (attemptsLeft > 1) {
                        console.log(`Image error, retrying... (${attemptsLeft - 1} left): ${url.substring(0, 50)}...`);
                        setTimeout(() => attemptLoad(attemptsLeft - 1), CONFIG.RETRY_DELAY);
                    } else {
                        window.loadingImages.delete(url);
                        window.failedImages.set(url, Date.now());
                        reject(new Error('Image load failed'));
                    }
                };

                // Add cache buster for retries to bypass browser cache
                const finalUrl = attemptsLeft < CONFIG.MAX_RETRIES 
                    ? url + (url.includes('?') ? '&' : '?') + '_retry=' + Date.now()
                    : url;
                img.src = finalUrl;
            };

            attemptLoad(retries);
        });
    };

    /**
     * Process images in an element with loading states
     */
    window.processImagesInElement = function(element) {
        if (!element) return;

        const images = element.querySelectorAll('img');
        
        images.forEach(img => {
            // Skip already processed images
            if (img.dataset.processed === 'true') return;
            img.dataset.processed = 'true';

            let src = img.getAttribute('src') || '';
            if (!src || src.startsWith('data:')) return;

            // Fix the URL
            src = src.replace(/&amp;/g, '&');
            const fixedSrc = window.convertDropboxUrl(src);

            // Store original source
            img.dataset.originalSrc = fixedSrc;

            // Add loading state
            img.style.opacity = '0';
            img.style.transition = 'opacity 0.3s ease';

            // Create loading placeholder
            const wrapper = document.createElement('div');
            wrapper.className = 'img-loading-wrapper';
            wrapper.style.cssText = 'position: relative; min-height: 100px; background: #f5f5f5; border-radius: 8px; display: flex; align-items: center; justify-content: center;';
            
            const spinner = document.createElement('div');
            spinner.className = 'img-spinner';
            spinner.style.cssText = 'position: absolute; width: 30px; height: 30px; border: 3px solid #e0e0e0; border-top-color: #667eea; border-radius: 50%; animation: imgSpin 1s linear infinite;';
            wrapper.appendChild(spinner);

            // Wrap the image
            if (img.parentNode) {
                img.parentNode.insertBefore(wrapper, img);
                wrapper.appendChild(img);
            }

            // Load image with retry
            window.loadImageWithRetry(fixedSrc)
                .then(() => {
                    img.src = fixedSrc;
                    img.style.opacity = '1';
                    wrapper.style.minHeight = '';
                    wrapper.style.background = '';
                    if (spinner.parentNode) spinner.remove();
                })
                .catch(err => {
                    console.warn('Image failed to load:', fixedSrc.substring(0, 50) + '...');
                    img.style.opacity = '0.3';
                    img.title = 'Image failed to load - click to retry';
                    img.style.cursor = 'pointer';
                    wrapper.style.background = '#ffebee';
                    
                    // Replace spinner with error icon
                    if (spinner.parentNode) spinner.remove();
                    const errorIcon = document.createElement('div');
                    errorIcon.innerHTML = '⚠️';
                    errorIcon.style.cssText = 'position: absolute; font-size: 24px; cursor: pointer;';
                    errorIcon.title = 'Click to retry loading image';
                    wrapper.appendChild(errorIcon);

                    // Click to retry
                    const retryHandler = () => {
                        errorIcon.innerHTML = '⏳';
                        window.failedImages.delete(fixedSrc);
                        window.loadImageWithRetry(fixedSrc)
                            .then(() => {
                                img.src = fixedSrc + (fixedSrc.includes('?') ? '&' : '?') + '_r=' + Date.now();
                                img.style.opacity = '1';
                                img.style.cursor = '';
                                wrapper.style.background = '';
                                errorIcon.remove();
                                img.removeEventListener('click', retryHandler);
                            })
                            .catch(() => {
                                errorIcon.innerHTML = '⚠️';
                            });
                    };
                    img.addEventListener('click', retryHandler);
                    errorIcon.addEventListener('click', retryHandler);
                });
        });
    };

    /**
     * Preload images from questions in batches
     */
    window.preloadQuestionImages = function(questions) {
        if (!questions || !Array.isArray(questions)) return Promise.resolve();

        const imageUrls = new Set();
        
        questions.forEach(q => {
            // Check HTML content for images
            if (q.html) {
                const matches = q.html.match(/src=["']([^"']+)["']/gi) || [];
                matches.forEach(match => {
                    const url = match.replace(/src=["']/i, '').replace(/["']$/, '');
                    if (url && !url.startsWith('data:')) {
                        imageUrls.add(window.convertDropboxUrl(url));
                    }
                });
            }
            
            // Check blocks for images
            if (q.blocks && Array.isArray(q.blocks)) {
                q.blocks.forEach(block => {
                    if (block.type === 'image' && block.value) {
                        imageUrls.add(window.convertDropboxUrl(block.value));
                    }
                });
            }
        });

        // Load images in batches
        const urls = Array.from(imageUrls);
        const batches = [];
        for (let i = 0; i < urls.length; i += CONFIG.PRELOAD_BATCH_SIZE) {
            batches.push(urls.slice(i, i + CONFIG.PRELOAD_BATCH_SIZE));
        }

        return batches.reduce((promise, batch) => {
            return promise.then(() => {
                return Promise.allSettled(batch.map(url => window.loadImageWithRetry(url)));
            });
        }, Promise.resolve());
    };

    /**
     * Refresh failed images
     */
    window.refreshFailedImages = function() {
        const failedUrls = Array.from(window.failedImages.keys());
        console.log(`Retrying ${failedUrls.length} failed images...`);
        
        failedUrls.forEach(url => {
            window.failedImages.delete(url);
        });

        // Find all images with failed state and retry
        document.querySelectorAll('img[style*="opacity: 0.3"]').forEach(img => {
            const src = img.dataset.originalSrc || img.src;
            if (src) {
                img.click(); // Trigger retry handler
            }
        });
    };

    /**
     * Clear image cache (useful when logging out/in)
     */
    window.clearImageCache = function() {
        window.imageCache.clear();
        window.failedImages.clear();
        window.loadingImages.clear();
        console.log('Image cache cleared');
    };

    // Add CSS for spinner animation if not exists
    if (!document.getElementById('img-loading-styles')) {
        const style = document.createElement('style');
        style.id = 'img-loading-styles';
        style.textContent = `
            @keyframes imgSpin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }
            .img-loading-wrapper {
                overflow: hidden;
            }
            .img-loading-wrapper img {
                max-width: 100%;
                border-radius: 8px;
            }
        `;
        document.head.appendChild(style);
    }

    // Process all images on DOM content loaded
    document.addEventListener('DOMContentLoaded', () => {
        // Process initial images
        document.querySelectorAll('.question-container').forEach(container => {
            window.processImagesInElement(container);
        });
    });

    // Observe DOM for new images
    const observer = new MutationObserver((mutations) => {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.classList?.contains('question-container') || 
                        node.classList?.contains('custom-question')) {
                        setTimeout(() => window.processImagesInElement(node), 100);
                    } else if (node.querySelectorAll) {
                        const containers = node.querySelectorAll('.question-container, .custom-question');
                        containers.forEach(container => {
                            setTimeout(() => window.processImagesInElement(container), 100);
                        });
                    }
                }
            });
        });
    });

    observer.observe(document.body, { childList: true, subtree: true });

    console.log('Enhanced image loading system initialized');
})();
