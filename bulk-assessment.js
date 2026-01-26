/**
 * Firebase Bulk Assessment Script
 * ================================
 * Exports, analyzes, and bulk-updates questions in the Question Bank
 * 
 * Usage:
 *   1. First, get a service account key from Firebase Console:
 *      - Go to Project Settings > Service Accounts
 *      - Click "Generate new private key"
 *      - Save as 'serviceAccountKey.json' in this folder
 *   
 *   2. Run: node bulk-assessment.js [command]
 *      Commands:
 *        export    - Export all questions to questions-export.json
 *        analyze   - Analyze questions and suggest corrections
 *        update    - Apply corrections from corrections.json
 *        report    - Generate a summary report
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Initialize Firebase Admin
let db;
try {
    const serviceAccount = require('./serviceAccountKey.json');
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: 'mathgen--app'
    });
    db = admin.firestore();
    console.log('✅ Firebase Admin initialized');
} catch (error) {
    console.error('❌ Error: serviceAccountKey.json not found');
    console.log('\nTo get your service account key:');
    console.log('1. Go to https://console.firebase.google.com/project/mathgen--app/settings/serviceaccounts/adminsdk');
    console.log('2. Click "Generate new private key"');
    console.log('3. Save the file as "serviceAccountKey.json" in this folder\n');
    process.exit(1);
}

// Level detection patterns
const LEVEL_PATTERNS = {
    P1: {
        keywords: ['count', 'number bond', 'addition within 20', 'subtraction within 20', 'shapes', 'patterns'],
        mathComplexity: 20
    },
    P2: {
        keywords: ['multiplication', 'division', '2-digit', 'length', 'mass', 'time', 'money'],
        mathComplexity: 100
    },
    P3: {
        keywords: ['3-digit', 'fractions', 'perimeter', 'area', 'bar graph', 'angles'],
        mathComplexity: 1000
    },
    P4: {
        keywords: ['4-digit', 'mixed numbers', 'decimals', 'symmetry', 'area of composite'],
        mathComplexity: 10000
    },
    P5: {
        keywords: ['percentage', 'ratio', 'rate', 'volume', 'average', 'algebra', 'pie chart'],
        mathComplexity: 100000
    },
    P6: {
        keywords: ['PSLE', 'speed', 'distance', 'time', 'circles', 'nets', 'pie charts'],
        mathComplexity: 1000000
    }
};

// Science topic patterns
const SCIENCE_TOPICS = {
    'Diversity': ['living', 'non-living', 'organisms', 'plants', 'animals', 'classify', 'characteristics'],
    'Cycles': ['life cycle', 'water cycle', 'reproduction', 'stages', 'metamorphosis'],
    'Systems': ['digestive', 'respiratory', 'circulatory', 'body system', 'organs'],
    'Interactions': ['food chain', 'food web', 'habitat', 'environment', 'adaptation', 'ecosystem'],
    'Energy': ['light', 'heat', 'electricity', 'magnet', 'force', 'energy conversion'],
    'Matter': ['states of matter', 'solid', 'liquid', 'gas', 'properties', 'materials']
};

/**
 * Export all questions from Firebase
 */
async function exportQuestions() {
    console.log('📥 Exporting questions from Firebase...\n');
    
    const collections = ['questions', 'questionBank', 'vetting'];
    const allQuestions = {};
    
    for (const collectionName of collections) {
        try {
            const snapshot = await db.collection(collectionName).get();
            if (!snapshot.empty) {
                allQuestions[collectionName] = [];
                snapshot.forEach(doc => {
                    allQuestions[collectionName].push({
                        id: doc.id,
                        ...doc.data()
                    });
                });
                console.log(`  ✓ ${collectionName}: ${snapshot.size} documents`);
            }
        } catch (error) {
            console.log(`  ⚠ ${collectionName}: ${error.message}`);
        }
    }
    
    // Save export
    const exportPath = path.join(__dirname, 'questions-export.json');
    fs.writeFileSync(exportPath, JSON.stringify(allQuestions, null, 2));
    console.log(`\n✅ Exported to ${exportPath}`);
    
    return allQuestions;
}

/**
 * Analyze question content to determine correct level/topic
 */
function analyzeQuestion(question) {
    const content = JSON.stringify(question).toLowerCase();
    const suggestions = {
        currentLevel: question.level || question.difficulty || 'Unknown',
        currentTopic: question.topic || question.category || 'Unknown',
        suggestedLevel: null,
        suggestedTopic: null,
        confidence: 0,
        reasons: []
    };
    
    // Analyze for level
    for (const [level, patterns] of Object.entries(LEVEL_PATTERNS)) {
        const matches = patterns.keywords.filter(kw => content.includes(kw.toLowerCase()));
        if (matches.length > 0) {
            if (!suggestions.suggestedLevel || matches.length > suggestions.confidence) {
                suggestions.suggestedLevel = level;
                suggestions.confidence = matches.length;
                suggestions.reasons = matches.map(m => `Contains "${m}"`);
            }
        }
    }
    
    // Analyze for science topic
    for (const [topic, keywords] of Object.entries(SCIENCE_TOPICS)) {
        const matches = keywords.filter(kw => content.includes(kw.toLowerCase()));
        if (matches.length > 0) {
            suggestions.suggestedTopic = topic;
            suggestions.topicReasons = matches.map(m => `Contains "${m}"`);
            break;
        }
    }
    
    // Check for numbers to estimate math level
    const numbers = content.match(/\d+/g) || [];
    const maxNumber = Math.max(...numbers.map(n => parseInt(n)), 0);
    if (maxNumber > 0) {
        for (const [level, patterns] of Object.entries(LEVEL_PATTERNS)) {
            if (maxNumber <= patterns.mathComplexity) {
                if (!suggestions.suggestedLevel) {
                    suggestions.suggestedLevel = level;
                    suggestions.reasons.push(`Max number ${maxNumber} suggests ${level}`);
                }
                break;
            }
        }
    }
    
    // Flag if current doesn't match suggested
    suggestions.needsReview = suggestions.suggestedLevel && 
        suggestions.currentLevel !== suggestions.suggestedLevel;
    
    return suggestions;
}

/**
 * Analyze all questions and generate corrections
 */
async function analyzeQuestions() {
    console.log('🔍 Analyzing questions...\n');
    
    // Load export or fetch fresh
    let questions;
    const exportPath = path.join(__dirname, 'questions-export.json');
    
    if (fs.existsSync(exportPath)) {
        questions = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
        console.log('  Using existing export file');
    } else {
        questions = await exportQuestions();
    }
    
    const corrections = [];
    const stats = { total: 0, needsReview: 0, byLevel: {} };
    
    for (const [collection, docs] of Object.entries(questions)) {
        console.log(`\n📂 Analyzing ${collection}...`);
        
        for (const doc of docs) {
            stats.total++;
            const analysis = analyzeQuestion(doc);
            
            // Track stats
            const level = analysis.currentLevel;
            stats.byLevel[level] = (stats.byLevel[level] || 0) + 1;
            
            if (analysis.needsReview) {
                stats.needsReview++;
                corrections.push({
                    collection,
                    id: doc.id,
                    current: {
                        level: analysis.currentLevel,
                        topic: analysis.currentTopic
                    },
                    suggested: {
                        level: analysis.suggestedLevel,
                        topic: analysis.suggestedTopic
                    },
                    confidence: analysis.confidence,
                    reasons: analysis.reasons,
                    approved: false  // Manual approval needed
                });
                
                console.log(`  ⚠ ${doc.id}: ${analysis.currentLevel} → ${analysis.suggestedLevel} (${analysis.reasons.join(', ')})`);
            }
        }
    }
    
    // Save corrections for review
    const correctionsPath = path.join(__dirname, 'corrections.json');
    fs.writeFileSync(correctionsPath, JSON.stringify(corrections, null, 2));
    
    console.log('\n📊 Analysis Summary:');
    console.log(`  Total questions: ${stats.total}`);
    console.log(`  Need review: ${stats.needsReview}`);
    console.log(`  By level:`, stats.byLevel);
    console.log(`\n✅ Corrections saved to ${correctionsPath}`);
    console.log('   Review the file and set "approved": true for changes you want to apply');
    
    return corrections;
}

/**
 * Apply approved corrections
 */
async function applyCorrections() {
    console.log('📝 Applying corrections...\n');
    
    const correctionsPath = path.join(__dirname, 'corrections.json');
    if (!fs.existsSync(correctionsPath)) {
        console.log('❌ No corrections.json found. Run "analyze" first.');
        return;
    }
    
    const corrections = JSON.parse(fs.readFileSync(correctionsPath, 'utf8'));
    const approved = corrections.filter(c => c.approved);
    
    console.log(`Found ${corrections.length} corrections, ${approved.length} approved\n`);
    
    if (approved.length === 0) {
        console.log('⚠ No approved corrections. Edit corrections.json and set "approved": true');
        return;
    }
    
    let updated = 0;
    let failed = 0;
    
    for (const correction of approved) {
        try {
            const updateData = {};
            if (correction.suggested.level) {
                updateData.level = correction.suggested.level;
            }
            if (correction.suggested.topic) {
                updateData.topic = correction.suggested.topic;
            }
            updateData.updatedAt = admin.firestore.FieldValue.serverTimestamp();
            updateData.updatedBy = 'bulk-assessment-script';
            
            await db.collection(correction.collection).doc(correction.id).update(updateData);
            console.log(`  ✓ Updated ${correction.id}`);
            updated++;
        } catch (error) {
            console.log(`  ✗ Failed ${correction.id}: ${error.message}`);
            failed++;
        }
    }
    
    console.log(`\n✅ Done: ${updated} updated, ${failed} failed`);
}

/**
 * Generate summary report
 */
async function generateReport() {
    console.log('📊 Generating Report...\n');
    
    const collections = ['questions', 'questionBank', 'vetting'];
    const report = {
        timestamp: new Date().toISOString(),
        collections: {}
    };
    
    for (const collectionName of collections) {
        try {
            const snapshot = await db.collection(collectionName).get();
            const docs = [];
            snapshot.forEach(doc => docs.push({ id: doc.id, ...doc.data() }));
            
            const byLevel = {};
            const byTopic = {};
            
            docs.forEach(doc => {
                const level = doc.level || doc.difficulty || 'Unspecified';
                const topic = doc.topic || doc.category || 'Unspecified';
                byLevel[level] = (byLevel[level] || 0) + 1;
                byTopic[topic] = (byTopic[topic] || 0) + 1;
            });
            
            report.collections[collectionName] = {
                total: docs.length,
                byLevel,
                byTopic
            };
        } catch (error) {
            report.collections[collectionName] = { error: error.message };
        }
    }
    
    // Print report
    console.log('═══════════════════════════════════════');
    console.log('       QUESTION BANK REPORT');
    console.log('═══════════════════════════════════════\n');
    
    for (const [collection, data] of Object.entries(report.collections)) {
        console.log(`📂 ${collection.toUpperCase()}`);
        if (data.error) {
            console.log(`   Error: ${data.error}\n`);
            continue;
        }
        console.log(`   Total: ${data.total}`);
        console.log(`   By Level:`);
        Object.entries(data.byLevel).sort().forEach(([level, count]) => {
            console.log(`     ${level}: ${count}`);
        });
        console.log(`   By Topic:`);
        Object.entries(data.byTopic).sort().forEach(([topic, count]) => {
            console.log(`     ${topic}: ${count}`);
        });
        console.log();
    }
    
    // Save report
    const reportPath = path.join(__dirname, 'report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`✅ Report saved to ${reportPath}`);
}

// CLI
const command = process.argv[2] || 'help';

switch (command) {
    case 'export':
        exportQuestions();
        break;
    case 'analyze':
        analyzeQuestions();
        break;
    case 'update':
        applyCorrections();
        break;
    case 'report':
        generateReport();
        break;
    default:
        console.log(`
Firebase Bulk Assessment Tool
=============================

Commands:
  node bulk-assessment.js export   - Export all questions to JSON
  node bulk-assessment.js analyze  - Analyze and suggest corrections  
  node bulk-assessment.js update   - Apply approved corrections
  node bulk-assessment.js report   - Generate summary report

Workflow:
  1. export  → Downloads all questions
  2. analyze → Identifies miscategorized questions
  3. Review corrections.json and approve changes
  4. update  → Applies your approved changes
        `);
}
