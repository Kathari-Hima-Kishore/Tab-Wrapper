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
    const SPEED_INTERVAL_MS = 500;
    const SPEED_PROBE_URL = 'https://tab-wrapper-pboeynppt-khks-projects-0ec29871.vercel.app';
    // Payload size per sample. 1 MB is big enough that the transfer dominates
    // the round trip at gigabit speeds - without it the number would really be
    // measuring latency and would cap out around a few hundred Mbps.
    const SPEED_PROBE_BYTES = 1048576;
    // Cap how long a single sample may take so a stalled request cannot block
    // the next tick or pile up behind itself.
    const SPEED_TIMEOUT_MS = 1500;

    let speedTimer = null;
    let speedAbort = null;

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

        // Navigating away must stop the timer, or a popup closed mid-interval
        // keeps the probe alive for the rest of the session.
        window.addEventListener('pagehide', stopSpeed);

        tickSpeed();
        speedTimer = setInterval(tickSpeed, SPEED_INTERVAL_MS);
    }

    function stopSpeed() {
        if (speedTimer) {
            clearInterval(speedTimer);
            speedTimer = null;
        }
        if (speedAbort) {
            speedAbort.abort();
            speedAbort = null;
        }
    }

    function renderOffline() {
        elements.speedPill.dataset.state = 'offline';
        elements.speedValue.textContent = 'Offline';
    }

    async function tickSpeed() {
        // Skip rather than overlap: a slow transfer must not queue up
        // concurrent requests behind it.
        if (speedAbort) return;

        const controller = new AbortController();
        speedAbort = controller;
        const timeout = setTimeout(() => controller.abort(), SPEED_TIMEOUT_MS);

        const url = `${SPEED_PROBE_URL}/api/speed?bytes=${SPEED_PROBE_BYTES}&t=${Date.now()}`;
        const started = performance.now();
        let response = null;
        try {
            response = await fetch(url, {
                method: 'GET',
                cache: 'no-store',
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            // The body must be fully read before stopping the clock, otherwise
            // this would time the headers rather than the transfer.
            const buffer = await response.arrayBuffer();
            const elapsed = performance.now() - started;
            const bytes = buffer.byteLength;

            // Mbps = bytes * 8 / seconds / 1e6. Guard against a zero-length
            // body or an impossibly fast clock reading producing Infinity.
            const mbps = elapsed > 0 ? (bytes * 8) / (elapsed * 1000) : 0;

            delete elements.speedPill.dataset.state;
            elements.speedValue.textContent = `${mbps.toFixed(2)} mbps`;
        } catch (error) {
            // An aborted probe means the request stalled or we navigated away.
            // Only surface a real failure while the popup is still open.
            if (error.name !== 'AbortError' && navigator.onLine !== false) {
                elements.speedPill.dataset.state = 'error';
                elements.speedValue.textContent = describeSpeedFailure(response, error);
            }
        } finally {
            clearTimeout(timeout);
            speedAbort = null;
        }
    }

    /**
     * Turn a failed probe into something the user can act on.
     *
     * A 404 almost always means the backend has not been redeployed since
     * /api/speed was added, which is a very different fix from "no internet".
     */
    function describeSpeedFailure(response, error) {
        if (response && response.status === 404) {
            return 'Redeploy API';
        }
        if (response && (response.status === 401 || response.status === 403)) {
            return 'API blocked';
        }
        if (response && response.status >= 500) {
            return 'API error';
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
