const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Execute the production functions, with no Firebase connection or real student data.
// WORKSHEET_TEST_SOURCE also allows checking these regressions against an older index.html.
const html = fs.readFileSync(process.env.WORKSHEET_TEST_SOURCE || path.join(__dirname, '..', 'index.html'), 'utf8');
const attemptStart = html.indexOf('// WORKSHEET ATTEMPT SYSTEM');
const attemptEnd = html.indexOf('// SHARED LESSONS SYSTEM', attemptStart);
const saveStart = html.indexOf('window.saveWorksheetAttempt = async function');
const saveEnd = html.indexOf('// MESSAGING SYSTEM', saveStart);
assert.ok(attemptStart >= 0 && attemptEnd > attemptStart && saveStart >= 0 && saveEnd > saveStart, 'Production worksheet functions must be present');
const productionSource = (html.slice(attemptStart, attemptEnd) + '\n' + html.slice(saveStart, saveEnd))
    .replace(/import\("https:\/\/www\.gstatic\.com\/firebasejs\/[^\"]+\/firebase-firestore\.js"\)/g, '__importFirestore()');

const copy = value => JSON.parse(JSON.stringify(value));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
async function until(predicate, description) {
    for (let i = 0; i < 50; i++) {
        if (predicate()) return;
        await Promise.resolve();
    }
    assert.fail(`Did not reach ${description}`);
}

function element(id = '', tagName = 'DIV') {
    const classes = new Set();
    return {
        id, tagName, textContent: '', innerHTML: '', value: '', style: {}, dataset: {}, attributes: {},
        disabled: false, checked: false, hidden: false,
        classList: {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            contains: name => classes.has(name),
            toggle(name, force) {
                const enabled = force === undefined ? !classes.has(name) : force;
                if (enabled) classes.add(name); else classes.delete(name);
                return enabled;
            }
        },
        setAttribute(name, value) { this.attributes[name] = String(value); },
        removeAttribute(name) { delete this.attributes[name]; },
        getAttribute(name) { return this.attributes[name] ?? null; },
        focus() {},
        querySelectorAll() { return []; },
        querySelector() { return null; }
    };
}

function makeDom() {
    const elements = new Map();
    for (const id of ['worksheet-attempt-modal', 'attempt-worksheet-title', 'attempt-worksheet-progress',
        'attempt-progress-bar', 'attempt-question-container', 'attempt-save-status']) {
        elements.set(id, element(id));
    }
    const buttons = ['attempt-prev-btn', 'attempt-next-btn', 'attempt-submit-btn', 'attempt-close-btn']
        .map(id => { const item = element(id, 'BUTTON'); elements.set(id, item); return item; });
    let inputs = [];
    let content = '';
    const container = elements.get('attempt-question-container');
    Object.defineProperty(container, 'innerHTML', {
        get: () => content,
        set(value) {
            content = value;
            for (const input of inputs) if (input.id) elements.delete(input.id);
            inputs = [];
            for (const match of value.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
                const id = match[1].match(/\bid="([^"]+)"/)?.[1];
                const input = element(id, 'TEXTAREA');
                input.value = match[2];
                inputs.push(input);
                if (id) elements.set(id, input);
            }
            for (const match of value.matchAll(/<input\b([^>]*)>/g)) {
                const input = element('', 'INPUT');
                input.type = match[1].match(/\btype="([^"]+)"/)?.[1];
                input.value = match[1].match(/\bvalue="([^"]*)"/)?.[1] || '';
                input.dataset.correct = match[1].match(/\bdata-correct="([^"]*)"/)?.[1];
                input.checked = /\bchecked\b/.test(match[1]);
                inputs.push(input);
            }
        }
    });
    container.querySelectorAll = selector => selector.includes('radio') ? inputs.filter(input => input.type === 'radio') : inputs;
    container.querySelector = selector => container.querySelectorAll(selector).find(input => !selector.includes(':checked') || input.checked) || null;
    const modal = elements.get('worksheet-attempt-modal');
    modal.querySelectorAll = selector => selector.includes('button') ? [...buttons, ...(selector.includes('input') || selector.includes('textarea') ? inputs : [])] : inputs;
    modal.querySelector = selector => selector.includes('modal-close-btn') ? buttons[3] : modal.querySelectorAll(selector)[0] || null;
    return {
        elements, buttons, modal, container,
        document: {
            getElementById: id => elements.get(id) || null,
            querySelectorAll: selector => modal.querySelectorAll(selector),
            querySelector: selector => modal.querySelector(selector)
        },
        controls: () => [...buttons, ...inputs]
    };
}

const textQuestion = (id = 'q-text') => ({ id, title: 'Synthetic explanation', topic: 'Synthetic topic', type: 'open-ended', html: '<p>Explain this synthetic observation.</p>' });
const mcqQuestion = id => ({ id, title: 'Synthetic choice', topic: 'Synthetic topic', type: 'mcq', html: '<p>Choose an option.</p><input type="radio" value="A" data-correct="true"><input type="radio" value="B" data-correct="false">' });
const worksheet = (name, questions = [textQuestion()]) => ({ name, questions });

function harness(options = {}) {
    const dom = makeDom();
    const alerts = [], confirmations = [], toasts = [], reads = [], writes = [];
    const stored = new Map();
    const worksheets = options.worksheets || { 'ws-a': worksheet('Synthetic worksheet A'), 'ws-b': worksheet('Synthetic worksheet B') };
    let allocated = 0;
    const firestore = {
        collection(_db, name) { return { collection: name }; },
        doc(...args) {
            if (args.length === 1) return { collection: args[0].collection, id: `synthetic-attempt-${++allocated}` };
            return { collection: args[1], id: args[2] };
        },
        async getDoc(ref) {
            reads.push(copy(ref));
            if (ref.collection === 'user_worksheets') {
                if (options.readWorksheet) return options.readWorksheet(ref);
                const data = worksheets[ref.id];
                return { exists: () => !!data, data: () => copy(data) };
            }
            if (options.readProfile) return options.readProfile(ref);
            return { exists: () => true, data: () => ({ students: [{ name: 'Synthetic Student', level: 'Synthetic Level' }] }) };
        },
        async setDoc(ref, data) {
            writes.push({ ref: copy(ref), data: copy(data) });
            if (options.write) await options.write(ref, data, stored, writes.length);
            stored.set(ref.id, copy(data));
        },
        async addDoc(ref, data) {
            const target = firestore.doc(ref);
            await firestore.setDoc(target, data);
            return target;
        },
        serverTimestamp: () => ({ syntheticServerTimestamp: true })
    };
    const context = {
        document: dom.document,
        auth: { currentUser: options.signedOut ? null : { uid: 'synthetic-user', email: 'student@example.invalid' } },
        db_fs: {},
        alert: message => alerts.push(String(message)),
        confirm: message => { confirmations.push(String(message)); return options.confirm !== false; },
        showToast: (message, kind) => toasts.push({ message, kind }),
        console: { log() {}, error() {}, warn() {} },
        __importFirestore: async () => {
            if (options.importError) throw new Error('Synthetic SDK import failure');
            return firestore;
        },
        setTimeout, clearTimeout
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(productionSource, context, { filename: 'index.html:worksheet-attempt-system' });
    return {
        window: context, dom, alerts, confirmations, toasts, reads, writes, stored,
        allocated: () => allocated,
        async open(id = 'ws-a') { await context.attemptWorksheet(id); return context.currentAttempt; },
        answer(value) {
            const input = dom.document.getElementById(`attempt-answer-${context.currentAttempt.currentIndex}`);
            assert.ok(input, 'Actual rendering must create the current answer input');
            input.value = value;
        },
        choose(value) {
            const radios = dom.container.querySelectorAll('input[type="radio"]');
            assert.ok(radios.some(input => input.value === value));
            for (const input of radios) input.checked = input.value === value;
        },
        successMessages: () => alerts.filter(message => /worksheet submitted/i.test(message)),
        feedback: () => [dom.elements.get('attempt-save-status').textContent, ...alerts, ...toasts.map(item => item.message)].join('\n')
    };
}

function assertRetained(h, attempt, answer) {
    assert.equal(h.window.currentAttempt, attempt);
    assert.equal(attempt.answers[0].studentAnswer, answer);
    assert.equal(h.dom.modal.classList.contains('visible'), true);
    assert.equal(h.dom.elements.get('attempt-submit-btn').disabled, false);
    assert.equal(h.dom.document.getElementById('attempt-answer-0').disabled, false);
    assert.equal(h.successMessages().length, 0);
    assert.match(h.feedback(), /retry|try again|sign in|signed out|log in/i);
}

test('save helper returns an explicit acknowledgement with its stable document ID', async () => {
    const h = harness();
    const saveState = {};
    const result = await h.window.saveWorksheetAttempt('ws-a', 'Synthetic worksheet A', [{ correct: true }], 'completed', saveState);
    assert.equal(result?.ok, true);
    assert.ok(result.attemptId);
    assert.equal(result.attemptId, saveState.id);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0].ref.id, result.attemptId);
});

test('success saves once, preserves grading/schema/content, and clears its own attempt', async () => {
    const questions = [mcqQuestion('q-correct'), mcqQuestion('q-wrong'), textQuestion('q-explain'), textQuestion('q-blank')];
    const h = harness({ worksheets: { 'ws-a': worksheet('Synthetic graded worksheet', questions) } });
    const attempt = await h.open();
    const originalQuestions = copy(attempt.questions);
    h.choose('A');
    h.window.nextAttemptQuestion();
    h.choose('B');
    h.window.nextAttemptQuestion();
    h.answer('Synthetic reasoning');
    h.window.nextAttemptQuestion();
    await h.window.submitWorksheetAttempt();
    assert.equal(h.writes.length, 1);
    assert.equal(h.stored.size, 1);
    const saved = h.writes[0].data;
    assert.deepEqual(Object.keys(saved).sort(), ['worksheetId', 'worksheetName', 'userId', 'userEmail', 'studentName', 'studentLevel', 'questionResults', 'score', 'status', 'completedAt'].sort());
    assert.deepEqual(saved, {
        worksheetId: 'ws-a', worksheetName: 'Synthetic graded worksheet', userId: 'synthetic-user', userEmail: 'student@example.invalid',
        studentName: 'Synthetic Student', studentLevel: 'Synthetic Level', score: 50, status: 'completed', completedAt: { syntheticServerTimestamp: true },
        questionResults: questions.map((q, i) => ({ questionId: q.id, questionTitle: q.title, topic: q.topic, type: q.type, studentAnswer: ['A', 'B', 'Synthetic reasoning', ''][i], correctAnswer: null, correct: i === 0 || i === 2 }))
    });
    assert.deepEqual(copy(attempt.questions), originalQuestions);
    assert.equal(h.successMessages().length, 1);
    assert.match(h.successMessages()[0], /Score: 50%[\s\S]*Correct: 2\/4[\s\S]*Wrong: 2/);
    assert.equal(h.window.currentAttempt.worksheetId, null);
    assert.equal(h.window.currentAttempt.answers.length, 0);
    assert.equal(h.dom.modal.classList.contains('visible'), false);
    assert.equal(h.dom.elements.get('attempt-submit-btn').disabled, false);
});

test('signed-out submission returns failure, keeps answers, and offers retry', async () => {
    const h = harness({ signedOut: true });
    const direct = await h.window.saveWorksheetAttempt('ws-a', 'Synthetic', [], 'completed', {});
    assert.equal(direct?.ok, false);
    const attempt = await h.open();
    h.answer('Synthetic signed-out answer');
    await h.window.submitWorksheetAttempt();
    assertRetained(h, attempt, 'Synthetic signed-out answer');
    assert.equal(h.writes.length, 0);
    assert.equal(h.reads.filter(ref => ref.collection === 'users').length, 0);
});

for (const stage of ['profile read', 'write']) {
    test(`rejected ${stage} returns failure, retains answers, and restores controls`, async () => {
        const reject = async () => { throw new Error(`Synthetic ${stage} rejection`); };
        const h = harness(stage === 'profile read' ? { readProfile: reject } : { write: reject });
        const direct = await h.window.saveWorksheetAttempt('ws-a', 'Synthetic', [], 'completed', {});
        assert.equal(direct?.ok, false);
        h.writes.length = 0;
        const attempt = await h.open();
        h.answer('Synthetic retained answer');
        await h.window.submitWorksheetAttempt();
        assertRetained(h, attempt, 'Synthetic retained answer');
        assert.equal(h.writes.length, stage === 'profile read' ? 0 : 1);
        assert.equal(h.stored.size, 0);
    });
}

test('duplicate submissions and navigation/cancel callbacks cannot change a pending save', async () => {
    const gate = deferred();
    const h = harness({ write: () => gate.promise, worksheets: { 'ws-a': worksheet('Synthetic duplicate worksheet', [textQuestion('q-one'), textQuestion('q-two')]) } });
    const attempt = await h.open();
    h.answer('First answer');
    h.window.nextAttemptQuestion();
    h.answer('Last answer');
    const first = h.window.submitWorksheetAttempt();
    const second = h.window.submitWorksheetAttempt();
    await until(() => h.writes.length === 1, 'pending write');
    assert.ok(h.dom.controls().every(control => control.disabled), 'All editable/modal controls are disabled while saving');
    h.window.prevAttemptQuestion();
    h.window.saveAttemptAnswer(1, 'Stale edit');
    h.window.cancelWorksheetAttempt();
    assert.equal(h.window.currentAttempt, attempt);
    assert.equal(attempt.currentIndex, 1);
    assert.equal(attempt.answers[1].studentAnswer, 'Last answer');
    assert.equal(h.confirmations.length, 0);
    assert.equal(h.writes.length, 1);
    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(h.writes.length, 1);
    assert.equal(h.successMessages().length, 1);
});

for (const uncertain of [false, true]) {
    test(`${uncertain ? 'uncertain write' : 'write failure'} followed by retry uses one document and succeeds only after acknowledgement`, async () => {
        const h = harness({
            async write(ref, data, stored, number) {
                if (number === 1) {
                    if (uncertain) stored.set(ref.id, copy(data));
                    throw new Error('Synthetic acknowledgement lost');
                }
            }
        });
        const attempt = await h.open();
        h.answer('Synthetic retry answer');
        await h.window.submitWorksheetAttempt();
        assertRetained(h, attempt, 'Synthetic retry answer');
        assert.equal(h.stored.size, uncertain ? 1 : 0);
        const firstId = h.writes[0].ref.id;
        await h.window.submitWorksheetAttempt();
        assert.equal(h.writes.length, 2);
        assert.equal(h.writes[1].ref.id, firstId);
        assert.equal(h.allocated(), 1);
        assert.deepEqual(h.writes[1].data.questionResults, h.writes[0].data.questionResults);
        assert.equal(h.stored.size, 1);
        assert.equal(h.successMessages().length, 1);
        assert.equal(h.window.currentAttempt.worksheetId, null);
    });
}

for (const succeeds of [true, false]) {
    test(`opening another attempt during a pending save survives the older ${succeeds ? 'acknowledgement' : 'failure'}`, async () => {
        const gate = deferred();
        const h = harness({ write: () => gate.promise });
        const oldAttempt = await h.open('ws-a');
        h.answer('Synthetic old answer');
        const pending = h.window.submitWorksheetAttempt();
        await until(() => h.writes.length === 1, 'old pending write');
        const newerAttempt = await h.open('ws-b');
        h.answer('Synthetic new answer');
        h.window.saveCurrentAttemptAnswer();
        const newerStatus = h.dom.elements.get('attempt-save-status').textContent;
        const newerTitle = h.dom.elements.get('attempt-worksheet-title').textContent;
        if (succeeds) gate.resolve(); else gate.reject(new Error('Synthetic old write failed'));
        await pending;
        assert.equal(h.window.currentAttempt, newerAttempt);
        assert.equal(newerAttempt.worksheetId, 'ws-b');
        assert.equal(newerAttempt.answers[0].studentAnswer, 'Synthetic new answer');
        assert.equal(h.dom.modal.classList.contains('visible'), true);
        assert.equal(h.dom.elements.get('attempt-save-status').textContent, newerStatus);
        assert.equal(h.dom.elements.get('attempt-worksheet-title').textContent, newerTitle);
        assert.equal(h.dom.elements.get('attempt-submit-btn').disabled, false);
        assert.equal(h.dom.document.getElementById('attempt-answer-0').disabled, false);
        assert.equal(h.writes[0].data.worksheetId, 'ws-a');
        assert.equal(h.writes[0].data.questionResults[0].studentAnswer, 'Synthetic old answer');
        if (!succeeds) {
            assert.equal(h.successMessages().length, 0);
            const resumed = await h.open('ws-a');
            assert.equal(resumed, oldAttempt);
            assertRetained(h, oldAttempt, 'Synthetic old answer');
            assert.equal(h.dom.document.getElementById('attempt-answer-0').value, 'Synthetic old answer');
        }
    });
}

test('a stale acknowledgement cannot unlock controls for a newer pending submission', async () => {
    const oldGate = deferred(), newGate = deferred();
    const h = harness({ write: (_ref, _data, _stored, number) => number === 1 ? oldGate.promise : newGate.promise });
    await h.open('ws-a');
    h.answer('Synthetic old answer');
    const oldSave = h.window.submitWorksheetAttempt();
    await until(() => h.writes.length === 1, 'old pending write');
    const newer = await h.open('ws-b');
    h.answer('Synthetic new answer');
    const newSave = h.window.submitWorksheetAttempt();
    await until(() => h.writes.length === 2, 'new pending write');
    oldGate.resolve();
    await oldSave;
    assert.equal(h.window.currentAttempt, newer);
    assert.equal(h.dom.elements.get('attempt-submit-btn').disabled, true);
    assert.equal(h.dom.document.getElementById('attempt-answer-0').disabled, true);
    newGate.resolve();
    await newSave;
    assert.equal(h.stored.size, 2);
    assert.equal(h.window.currentAttempt.worksheetId, null);
});

test('authentication change after profile lookup does not write or discard answers', async () => {
    const profileGate = deferred();
    const h = harness({ readProfile: () => profileGate.promise });
    const attempt = await h.open();
    h.answer('Synthetic account-bound answer');
    const pending = h.window.submitWorksheetAttempt();
    await until(() => h.reads.some(ref => ref.collection === 'users'), 'profile lookup');
    h.window.auth.currentUser = { uid: 'different-synthetic-user', email: 'other@example.invalid' };
    profileGate.resolve({ exists: () => false });
    await pending;
    assertRetained(h, attempt, 'Synthetic account-bound answer');
    assert.equal(h.writes.length, 0);
});

test('an uncertain write cannot be retried under another account', async () => {
    const h = harness({ write: async () => { throw new Error('Synthetic uncertain write'); } });
    const attempt = await h.open();
    h.answer('Synthetic original-account answer');
    await h.window.submitWorksheetAttempt();
    h.window.auth.currentUser = { uid: 'different-synthetic-user', email: 'other@example.invalid' };
    await h.window.submitWorksheetAttempt();
    assertRetained(h, attempt, 'Synthetic original-account answer');
    assert.equal(h.writes.length, 1);
});

test('declining unanswered confirmation retains the attempt without saving', async () => {
    const h = harness({ confirm: false });
    const attempt = await h.open();
    await h.window.submitWorksheetAttempt();
    assert.equal(h.window.currentAttempt, attempt);
    assert.equal(h.writes.length, 0);
    assert.equal(h.successMessages().length, 0);
    assert.equal(h.dom.elements.get('attempt-submit-btn').disabled, false);
});

test('submitting without an active attempt is harmless', async () => {
    const h = harness();
    await h.window.submitWorksheetAttempt();
    assert.equal(h.writes.length, 0);
    assert.equal(h.successMessages().length, 0);
});

test('switching worksheets captures an unsaved MCQ selection and restores it on reopen', async () => {
    const h = harness({ worksheets: { 'ws-a': worksheet('Synthetic choice worksheet', [mcqQuestion('q-choice')]), 'ws-b': worksheet('Synthetic worksheet B') } });
    const attempt = await h.open('ws-a');
    h.choose('A');
    await h.open('ws-b');
    assert.equal(attempt.answers[0].studentAnswer, 'A');
    assert.equal(attempt.answers[0].correct, true);
    assert.equal(await h.open('ws-a'), attempt);
    assert.equal(h.dom.container.querySelector('input[type="radio"]:checked').value, 'A');
    assert.equal(h.writes.length, 0);
});

test('out-of-order worksheet loads cannot replace the most recently opened attempt', async () => {
    const oldLoad = deferred(), newLoad = deferred();
    const h = harness({ readWorksheet: ref => ref.id === 'ws-a' ? oldLoad.promise : newLoad.promise });
    const oldOpen = h.open('ws-a');
    const newOpen = h.open('ws-b');
    await until(() => h.reads.length === 2, 'both worksheet loads');
    newLoad.resolve({ exists: () => true, data: () => worksheet('Synthetic newer worksheet') });
    const newer = await newOpen;
    h.answer('Synthetic newest answer');
    h.window.saveCurrentAttemptAnswer();
    oldLoad.resolve({ exists: () => true, data: () => worksheet('Synthetic older worksheet') });
    await oldOpen;
    assert.equal(h.window.currentAttempt, newer);
    assert.equal(newer.worksheetId, 'ws-b');
    assert.equal(newer.answers[0].studentAnswer, 'Synthetic newest answer');
    assert.match(h.dom.elements.get('attempt-worksheet-title').textContent, /newer/);
});

for (const attemptId of [undefined, 'different-save-id']) {
    test(`a success result with ${attemptId ? 'a different' : 'no'} attempt ID cannot discard answers`, async () => {
        const h = harness();
        const attempt = await h.open();
        attempt.saveState.id = 'expected-save-id';
        h.answer('Synthetic unacknowledged answer');
        h.window.saveWorksheetAttempt = async () => ({ ok: true, attemptId });
        await h.window.submitWorksheetAttempt();
        assertRetained(h, attempt, 'Synthetic unacknowledged answer');
    });
}

test('SDK import failure retains answers and restores controls', async () => {
    const options = {};
    const h = harness(options);
    const attempt = await h.open();
    h.answer('Synthetic import-failure answer');
    options.importError = true;
    await h.window.submitWorksheetAttempt();
    assertRetained(h, attempt, 'Synthetic import-failure answer');
    assert.equal(h.writes.length, 0);
});
