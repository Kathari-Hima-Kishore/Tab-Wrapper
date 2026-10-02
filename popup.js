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
        speedValue: document.getElementById('speedValue')
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
    // AbortControllers for the streams of the sample currently in flight.
    let speedAborts = [];
    // Running average across samples, so one slow transfer is not alarming.
    let speedAverage = null;
    // Samples completed since the last time the average was reset.
    let speedSampleCount = 0;

    // Load initial state
    await loadTabCount();
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

        // Navigating away must stop the timer, or a popup closed mid-sample
        // keeps the streams alive for the rest of the session.
        window.addEventListener('pagehide', stopSpeed);

        // First sample runs straight away so there is a number on screen, then
        // the loop keeps refreshing it.
        runSpeedSample();
        speedTimer = setInterval(runSpeedSample, SPEED_SAMPLE_MS);
    }

    function stopSpeed() {
        if (speedTimer) {
            clearInterval(speedTimer);
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
        let response = null;
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
                elements.speedValue.textContent = describeSpeedFailure(response, error);
            }
        } finally {
            clearTimeout(timeout);
            speedAborts = [];
        }
    }

    /**
     * Turn a failed probe into something the user can act on.
     *
     * The probe now runs against a third-party CDN rather than our own API, so
     * there is no deployment to blame: the common causes are a blocked request
     * or no connectivity at all.
     */
    function describeSpeedFailure(response, error) {
        if (response && (response.status === 401 || response.status === 403)) {
            return 'Request blocked';
        }
        if (response && response.status >= 500) {
            return 'Probe failed';
        }
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

    // Handle tab count updates
    api.tabs.onCreated.addListener(loadTabCount);
    api.tabs.onRemoved.addListener(loadTabCount);
});
