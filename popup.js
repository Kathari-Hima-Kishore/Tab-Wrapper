// Popup UI controller for Tab Wrapper extension
// Cross-browser compatible: Chrome, Edge, Firefox, Brave

// Cross-browser API wrapper
const api = typeof browser !== 'undefined' ? browser : chrome;

document.addEventListener('DOMContentLoaded', async () => {
    // Get DOM elements
    const elements = {
        initialState: document.getElementById('initialState'),
        processingState: document.getElementById('processingState'),
        completeState: document.getElementById('completeState'),
        errorState: document.getElementById('errorState'),
        tabCount: document.getElementById('tabCount'),
        organizeButton: document.getElementById('organizeButton'),
        organizeAgainButton: document.getElementById('organizeAgainButton'),
        retryButton: document.getElementById('retryButton'),
        resultBox: document.getElementById('resultBox'),
        resultText: document.getElementById('resultText'),
        resultDetail: document.getElementById('resultDetail'),
        errorText: document.getElementById('errorText'),
        errorDetail: document.getElementById('errorDetail'),
        speedPill: document.getElementById('speedPill'),
        speedValue: document.getElementById('speedValue'),
        // Notes
        notesSection: document.getElementById('notesSection'),
        notesBar: document.getElementById('notesBar'),
        notesToggle: document.getElementById('notesToggle'),
        notesBody: document.getElementById('notesBody'),
        notesAdd: document.getElementById('notesAdd'),
        notesEmpty: document.getElementById('notesEmpty'),
        notesGrid: document.getElementById('notesGrid'),
        viewSwitch: document.getElementById('viewSwitch'),
        notesChevron: document.getElementById('notesChevron'),
        noteEditor: document.getElementById('noteEditor'),
        noteEditorBack: document.getElementById('noteEditorBack'),
        noteEditorDelete: document.getElementById('noteEditorDelete'),
        noteEditorMode: document.getElementById('noteEditorMode'),
        noteEditorTitle: document.getElementById('noteEditorTitle'),
        noteEditorBody: document.getElementById('noteEditorBody'),
        noteEditorStatus: document.getElementById('noteEditorStatus')
    };

    /**
     * Live network readout, refreshed every 200ms.
     *
     * Why a real probe instead of navigator.connection: that API's `downlink`
     * is a cached estimate the browser only revises when the connection profile
     * changes, so polling it faster just reprints the same number. Timing an
     * actual round trip gives a measurement that genuinely moves each tick.
     *
     * The probe targets this extension's own API host, the only origin already
     * granted in host_permissions - so no extra permission is requested and
     * nothing off-origin is contacted.
     */
    // Declared BEFORE initSpeed() is called below. const/let live in the
    // temporal dead zone until execution reaches them, so calling a function
    // that reads them earlier throws "Cannot access before initialization".
    //
    // Measurement follows the LibreSpeed approach: several downloads running
    // in parallel over a sustained window. A single small transfer reports
    // roughly twice the real speed on a typical connection, because it reads
    // the peak burst rate before congestion control has settled rather than
    // the sustained rate a real download would experience.
    const SPEED_PROBE_URL = 'https://speed.cloudflare.com/__down';
    // Parallel streams per sample. More streams fill the pipe more completely,
    // which is what makes the result comparable to a multi-connection test.
    const SPEED_STREAMS = 6;
    // Payload per stream. Streams run concurrently, so this is the total
    // sample size divided across them, not a per-stream round trip.
    const SPEED_STREAM_BYTES = 1000000;
    // Seconds per sample. A longer window averages out per-transfer noise, at
    // the cost of the readout updating less often.
    const SPEED_SAMPLE_MS = 2000;
    // Samples discarded at the start. The first transfers pay for TCP and TLS
    // setup and are always slow, which would otherwise drag the average down.
    const SPEED_WARMUP_SAMPLES = 1;
    // Weight per sample in the running average, so the readout settles rather
    // than jumping between samples.
    const SPEED_SMOOTHING = 0.4;
    // Backstop so a stalled stream cannot hang the loop indefinitely.
    const SPEED_TIMEOUT_MS = 8000;

    let speedTimer = null;
    // Whether the speed loop has been stopped (popup closed/navigated away,
    // or rendered offline). Prevents the sample's finally block from reviving
    // the chain after stopSpeed().
    let speedStopped = false;
    // AbortControllers for the streams of the sample currently in flight.
    let speedAborts = [];
    // Running average across samples, so one slow transfer is not alarming.
    let speedAverage = null;
    // Samples completed since the last time the average was reset.
    let speedSampleCount = 0;

    // Paint the base UI, then start the probe. resetToInitial() ends by
    // calling loadTabCount(), and that query must not gate anything: awaiting
    // it before initSpeed() meant the speed probe only started once the
    // tab-info call resolved, which read as a startup delay on open.
    initSpeed();
    resetToInitial();

    // Event listeners
    elements.organizeButton.addEventListener('click', organizeTabs);
    elements.organizeAgainButton.addEventListener('click', organizeTabs);
    elements.retryButton.addEventListener('click', organizeTabs);

    /**
     * Load and display the current tab count
     */
    async function loadTabCount() {
        try {
            const tabs = await api.tabs.query({ currentWindow: true });
            const tabCount = tabs.length;
            elements.tabCount.textContent = `${tabCount} tabs open`;

            // Disable button if less than 2 tabs
            elements.organizeButton.disabled = tabCount < 2;
            if (tabCount < 2) {
                elements.tabCount.textContent = `${tabCount} tabs (need 2+)`;
            }
        } catch (error) {
            console.error('Error loading tab count:', error);
            elements.tabCount.textContent = 'Error loading tabs';
        }
    }

    function initSpeed() {
        // Offline is a hard state, not a measurement - short-circuit the loop.
        if (navigator.onLine === false) {
            renderOffline();
            return;
        }
        speedStopped = false;

        // Navigating away must stop the timer, or a popup closed mid-sample
        // keeps the streams alive for the rest of the session.
        window.addEventListener('pagehide', stopSpeed);

        // First sample runs straight away so there is a number on screen, then
        // finished samples chain straight into the next one with a 2s cadence.
        runSpeedSample();
    }

    function stopSpeed() {
        speedStopped = true;
        if (speedTimer) {
            clearTimeout(speedTimer);
            speedTimer = null;
        }
        speedAborts.forEach((c) => c.abort());
        speedAborts = [];
    }

    function renderOffline() {
        elements.speedPill.dataset.state = 'offline';
        elements.speedValue.textContent = 'Offline';
    }

    async function runSpeedSample() {
        // Skip rather than overlap: a slow sample must not queue a second set
        // of streams behind the first.
        if (speedAborts.length) return;

        speedAborts = new Array(SPEED_STREAMS)
            .fill(0)
            .map(() => new AbortController());
        const controllers = [...speedAborts];
        const timeout = setTimeout(() => controllers.forEach((c) => c.abort()), SPEED_TIMEOUT_MS);

        const started = performance.now();
        try {
            // All streams launch together, then every body is awaited before
            // the clock stops. Timing a single stream would understate the
            // link, and stopping early would time only the headers.
            const results = await Promise.allSettled(
                controllers.map((controller) => fetch(
                    `${SPEED_PROBE_URL}?bytes=${SPEED_STREAM_BYTES}&t=${Date.now()}`,
                    { method: 'GET', cache: 'no-store', signal: controller.signal }
                ).then(async (r) => {
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    const b = await r.arrayBuffer();
                    return b.byteLength;
                }))
            );

            // A sample needs most of its streams to be usable, otherwise the
            // aggregate is not measuring the link.
            const succeeded = results.filter((r) => r.status === 'fulfilled');
            if (succeeded.length < SPEED_STREAMS / 2) {
                throw new Error(results.find((r) => r.status === 'rejected')?.reason
                    || new Error('too few streams completed'));
            }

            const elapsed = performance.now() - started;
            const bytes = succeeded.reduce((sum, r) => sum + r.value, 0);
            // Mbps = bytes * 8 / seconds / 1e6.
            const mbps = elapsed > 0 ? (bytes * 8) / (elapsed * 1000) : 0;

            speedSampleCount++;
            // Discard warm-up samples, which carry connection setup cost.
            if (speedSampleCount > SPEED_WARMUP_SAMPLES) {
                speedAverage = speedAverage === null
                    ? mbps
                    : speedAverage + SPEED_SMOOTHING * (mbps - speedAverage);

                delete elements.speedPill.dataset.state;
                elements.speedValue.textContent = `${speedAverage.toFixed(2)} mbps`;
            }
        } catch (error) {
            // An aborted probe means the stream stalled or we navigated away.
            // Only surface a real failure while the popup is still open.
            if (error.name !== 'AbortError' && navigator.onLine !== false) {
                // Drop the average: a failed sample should not bias the next
                // reading towards a value we no longer have evidence for.
                speedAverage = null;
                speedSampleCount = 0;
                elements.speedPill.dataset.state = 'error';
                elements.speedValue.textContent = describeSpeedFailure(error);
            }
        } finally {
            clearTimeout(timeout);
            speedAborts = [];
            // Chain the next sample so the readout refreshes on a ~2s cadence.
            // setInterval was gating on a separate clock and skipped ticks
            // while a sample was in flight, so updates effectively ran every
            // ~4s. Chaining from each finish keeps it at one sample per 2s
            // (or per sample-duration on links slower than the window).
            if (!speedStopped && navigator.onLine !== false) {
                const elapsed = performance.now() - started;
                speedTimer = setTimeout(
                    runSpeedSample,
                    Math.max(0, SPEED_SAMPLE_MS - elapsed)
                );
            }
        }
    }

    /**
     * Turn a failed probe into something the user can act on.
     *
     * The probe runs against a third-party CDN rather than our own API, so
     * there is no deployment to blame: the realistic causes are no
     * connectivity at all, or the request being blocked before it lands.
     *
     * Only the rejection reason is inspected. A non-2xx reply never reaches
     * here as a Response - the stream wrapper turns it into a plain Error
     * carrying the status in its message - so there is no status code to
     * branch on.
     */
    function describeSpeedFailure(error) {
        // fetch rejects with a TypeError only when the request never made it
        // onto the network: offline, DNS failure, or blocked by policy.
        if (error instanceof TypeError) {
            return 'No connection';
        }
        return 'Speed unavailable';
    }

    /**
     * Main function to organize tabs using AI
     */
    async function organizeTabs() {
        showProcessing();

        try {
            // Send message to background script
            const response = await api.runtime.sendMessage({
                action: 'organizeTabs'
            });

            if (response.success) {
                showSuccess(
                    'Tabs organized successfully!',
                    `Created ${response.groupCount} smart groups`
                );
            } else {
                showError(
                    'Organization Failed',
                    response.error || 'An unknown error occurred'
                );
            }
        } catch (error) {
            console.error('Tab Wrapper: Error organizing tabs:', error);
            showError(
                'Communication Error',
                error.message || 'Could not connect to background service.'
            );
        }
    }

    /**
     * Show processing state
     */
    function showProcessing() {
        hideAllStates();
        elements.processingState.style.display = 'block';
        // Hide the title block so the loader is the only thing on screen
        document.body.classList.add('is-processing');
    }

    /**
     * Show success state
     */
    function showSuccess(title, detail) {
        hideAllStates();
        elements.completeState.style.display = 'block';

        elements.resultBox.className = 'result success';
        elements.resultText.textContent = title;
        elements.resultDetail.textContent = detail;
    }

    /**
     * Show error state
     */
    function showError(title, detail) {
        hideAllStates();
        elements.errorState.style.display = 'block';
        elements.errorText.textContent = title;
        elements.errorDetail.textContent = detail;
    }

    /**
     * Hide all state containers
     */
    function hideAllStates() {
        elements.initialState.style.display = 'none';
        elements.processingState.style.display = 'none';
        elements.completeState.style.display = 'none';
        elements.errorState.style.display = 'none';
        // Restore the title block on every state change; showProcessing()
        // re-adds it, so the header only ever hides while the loader shows.
        document.body.classList.remove('is-processing');
    }

    /**
     * Reset to initial state
     */
    function resetToInitial() {
        hideAllStates();
        elements.initialState.style.display = 'block';
        loadTabCount();
    }

    /* ===================== Notes ===================== */

    // One namespaced key holds every note. localStorage is per-extension and
    // survives the popup closing, so the notes are there again on reopen.
    const NOTES_KEY = 'tab-wrapper:notes:v1';
    let notes = [];
    // id of the note currently open in the editor; null means a new note.
    let activeNoteId = null;
    // Debounce so typing does not hit localStorage on every keystroke.
    let noteSaveTimer = null;

    function loadNotes() {
        try {
            const raw = localStorage.getItem(NOTES_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            // Guard against a corrupt or hand-edited value rather than letting
            // it break the whole popup.
            notes = Array.isArray(parsed) ? parsed.filter((n) => n && typeof n.id === 'string') : [];
        } catch (error) {
            console.error('Tab Wrapper: could not read notes:', error);
            notes = [];
        }
    }

    function persistNotes() {
        try {
            localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
        } catch (error) {
            console.error('Tab Wrapper: could not save notes:', error);
        }
    }

    function createNote() {
        return {
            id: `n_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            title: '',
            body: '',
            updatedAt: Date.now()
        };
    }

    // Newest first, so a freshly written note lands at the top-left.
    function sortedNotes() {
        return [...notes].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    function initNotes() {
        loadNotes();

        elements.notesToggle.addEventListener('click', () => setNotesOpen(!notesOpen()));
        elements.notesChevron.addEventListener('click', () => setNotesOpen(!notesOpen()));
        elements.notesAdd.addEventListener('click', () => openEditor(null));
        elements.noteEditorBack.addEventListener('click', closeEditor);
        elements.noteEditorDelete.addEventListener('click', deleteActiveNote);
        elements.viewSwitch.addEventListener('click', toggleNoteView);

        restoreNoteView();

        // Live save. The title/body are written straight into the active note
        // and persisted after a short pause, so closing the popup at any moment
        // keeps what was typed.
        elements.noteEditorTitle.addEventListener('input', onEditorInput);
        elements.noteEditorBody.addEventListener('input', onEditorInput);

        renderNotes();
    }

    function notesOpen() {
        return elements.notesSection.classList.contains('open');
    }

    /* ---- Note card shape: squares (2 across) vs rectangles (1 across) ---- */

    const NOTE_VIEW_KEY = 'tab-wrapper:notes-view:v1';

    function getNoteView() {
        try {
            return localStorage.getItem(NOTE_VIEW_KEY) === 'list' ? 'list' : 'grid';
        } catch (error) {
            return 'grid';
        }
    }

    function applyNoteView(view) {
        const isList = view === 'list';
        elements.notesGrid.classList.toggle('list', isList);
        elements.viewSwitch.setAttribute('aria-checked', String(isList));
        try {
            localStorage.setItem(NOTE_VIEW_KEY, view);
        } catch (error) {
            // Non-fatal: view just falls back to default next open.
        }
        // Keep the expanded shelf's height cap in step with the grid.
        if (notesOpen()) elements.notesBody.style.maxHeight = 'none';
    }

    function toggleNoteView() {
        applyNoteView(getNoteView() === 'list' ? 'grid' : 'list');
    }

    function restoreNoteView() {
        applyNoteView(getNoteView());
    }

    function setNotesOpen(open) {
        const section = elements.notesSection;
        const body = elements.notesBody;
        // Measured before the class flips, so this is the width we animate
        // away from rather than the one we land on.
        const barFromWidth = elements.notesBar.getBoundingClientRect().width;

        if (open) {
            // Measure the natural height, animate to it, then release the cap
            // so the panel can grow/shrink with its content while open.
            body.style.maxHeight = `${body.scrollHeight}px`;
            section.classList.add('open');
            elements.notesToggle.setAttribute('aria-expanded', 'true');
            body.addEventListener('transitionend', function release(event) {
                if (event.propertyName !== 'max-height') return;
                if (notesOpen()) body.style.maxHeight = 'none';
                body.removeEventListener('transitionend', release);
            });
        } else {
            // Coming from 'none' there is no height to interpolate from, so pin
            // the current height for one frame before collapsing.
            body.style.maxHeight = `${body.scrollHeight}px`;
            void body.offsetHeight;
            body.style.maxHeight = '0px';
            section.classList.remove('open');
            elements.notesToggle.setAttribute('aria-expanded', 'false');
        }

        resizeNotesBar(elements.notesBar, barFromWidth);
    }

    // Bumped on every toggle so an in-flight resize can tell it has been
    // superseded and must not release the newer animation's inline width.
    let notesBarAnim = 0;

    /**
     * Animate the notes bar between its shrink-wrapped and full-width states.
     *
     * The width cannot be left to the CSS transition: the two ends resolve
     * from different sources (`fit-content` on the label vs 100% of the
     * column) and are not interpolable, so the property would change
     * discretely and snap. Pinning both ends in pixels around a measurement
     * gives the transition two numbers it can actually interpolate.
     */
    function resizeNotesBar(bar, from) {
        const token = ++notesBarAnim;

        // Read the target with any inline width cleared, so the CSS state is
        // what decides it. Nothing paints between this and the pin below, so
        // the end state never flashes on screen first.
        bar.style.transition = 'none';
        bar.style.width = '';
        const to = bar.getBoundingClientRect().width;

        if (!to || Math.abs(to - from) < 0.5) {
            bar.style.transition = '';
            bar.style.width = '';
            return;
        }

        bar.style.width = `${from}px`;
        void bar.offsetWidth;   // flush the pinned start before animating
        bar.style.transition = '';
        bar.style.width = `${to}px`;

        // Hand sizing back to CSS once the transition has landed, so the bar
        // keeps responding to its own content afterwards. A later toggle bumps
        // the token and owns the cleanup from then on.
        setTimeout(() => {
            if (token !== notesBarAnim) return;
            bar.style.transition = '';
            bar.style.width = '';
        }, 380);
    }

    function renderNotes() {
        elements.notesGrid.replaceChildren();

        if (notes.length === 0) {
            elements.notesEmpty.hidden = false;
        } else {
            elements.notesEmpty.hidden = true;
            for (const note of sortedNotes()) {
                elements.notesGrid.appendChild(buildNoteCard(note));
            }
        }

        // If the shelf is open, keep the cap in step with the new content.
        if (notesOpen()) elements.notesBody.style.maxHeight = 'none';
    }

    function buildNoteCard(note) {
        const wrap = document.createElement('div');
        wrap.className = 'note-card-wrap';

        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'note-card';

        const title = document.createElement('div');
        title.className = 'note-card__title';
        title.textContent = note.title.trim() || 'Untitled';

        const snippet = document.createElement('div');
        snippet.className = 'note-card__snippet';
        snippet.textContent = note.body;

        card.append(title, snippet);
        // Driving the card from data avoids inline handlers, which a stricter
        // extension CSP would refuse.
        card.addEventListener('click', () => openEditor(note.id));

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'note-card__del';
        del.title = 'Delete note';
        del.setAttribute('aria-label', 'Delete note');
        del.textContent = '\u00d7';   // multiplication sign reads as a close glyph
        del.addEventListener('click', () => deleteNote(note.id));

        wrap.append(card, del);
        return wrap;
    }

    function openEditor(id) {
        activeNoteId = id;
        const note = id ? notes.find((n) => n.id === id) : null;

        elements.noteEditorMode.textContent = note ? 'Editing note' : 'New note';
        elements.noteEditorTitle.value = note ? note.title : '';
        elements.noteEditorBody.value = note ? note.body : '';
        // A brand-new note has nothing to delete until the first keystroke.
        elements.noteEditorDelete.hidden = !note;

        elements.noteEditor.classList.add('is-open');
        elements.noteEditor.setAttribute('aria-hidden', 'false');
        document.body.classList.add('is-editing');

        // Focus after the reveal transition starts so the caret is not placed
        // while the panel is still moving.
        setTimeout(() => elements.noteEditorTitle.focus(), 60);
    }

    function closeEditor() {
        // Flush any debounced write before leaving the editor.
        flushNote();
        elements.noteEditor.classList.remove('is-open');
        elements.noteEditor.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('is-editing');
        elements.noteEditorStatus.textContent = '';
        activeNoteId = null;
        renderNotes();
    }

    function onEditorInput() {
        const title = elements.noteEditorTitle.value;
        const body = elements.noteEditorBody.value;

        let note = activeNoteId ? notes.find((n) => n.id === activeNoteId) : null;
        if (!note) {
            // First keystroke on a new note: create it and adopt its id, so
            // everything after this edits the same record.
            if (!title.trim() && !body.trim()) return;
            note = createNote();
            notes.push(note);
            activeNoteId = note.id;
            elements.noteEditorMode.textContent = 'Editing note';
            elements.noteEditorDelete.hidden = false;
        }

        note.title = title;
        note.body = body;
        note.updatedAt = Date.now();

        elements.noteEditorStatus.textContent = 'Saving...';
        clearTimeout(noteSaveTimer);
        noteSaveTimer = setTimeout(flushNote, 300);
    }

    function flushNote() {
        clearTimeout(noteSaveTimer);
        noteSaveTimer = null;
        persistNotes();
        if (elements.noteEditor.classList.contains('is-open')) {
            elements.noteEditorStatus.textContent = 'Saved';
        }
    }

    function deleteNote(id) {
        notes = notes.filter((n) => n.id !== id);
        persistNotes();
        if (activeNoteId === id) {
            closeEditor();
        } else {
            renderNotes();
        }
    }

    function deleteActiveNote() {
        if (!activeNoteId) return;
        // Clearing the id first means the shared delete path takes the
        // "just re-render" branch instead of recursing through closeEditor.
        const id = activeNoteId;
        activeNoteId = null;
        notes = notes.filter((n) => n.id !== id);
        persistNotes();
        closeEditor();
    }

    // Persist anything pending if the popup is torn down mid-edit.
    window.addEventListener('pagehide', flushNote);

    // Called last, after every const above is initialized. initNotes() reads
    // NOTES_KEY, and a const is in the temporal dead zone until execution
    // reaches it - calling it from the top of this handler throws before any
    // listener is attached, taking the organize buttons down with it.
    initNotes();

    // Handle tab count updates
    api.tabs.onCreated.addListener(loadTabCount);
    api.tabs.onRemoved.addListener(loadTabCount);
});
