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
        tabsPerGroup: document.getElementById('tabsPerGroup'),
        sliderValue: document.getElementById('sliderValue'),
        autoModeBtn: document.getElementById('autoModeBtn'),
        manualModeBtn: document.getElementById('manualModeBtn'),
        modeDescription: document.getElementById('modeDescription'),
        manualSlider: document.getElementById('manualSlider')
    };

    // Current mode: 'auto' or 'manual'
    let currentMode = 'auto';

    // Load initial state
    await loadTabCount();
    resetToInitial();

    // Slider listener
    elements.tabsPerGroup.addEventListener('input', (e) => {
        elements.sliderValue.textContent = e.target.value;
    });

    // Mode toggle listeners
    elements.autoModeBtn.addEventListener('click', () => setMode('auto'));
    elements.manualModeBtn.addEventListener('click', () => setMode('manual'));

    function setMode(mode) {
        currentMode = mode;
        if (mode === 'auto') {
            elements.autoModeBtn.style.borderColor = '#7c3aed';
            elements.autoModeBtn.style.background = 'rgba(124, 58, 237, 0.15)';
            elements.autoModeBtn.style.color = '#7c3aed';
            elements.manualModeBtn.style.borderColor = '#3f3f46';
            elements.manualModeBtn.style.background = 'transparent';
            elements.manualModeBtn.style.color = '#9ca3af';
            elements.modeDescription.textContent = 'AI decides optimal grouping';
            elements.modeDescription.style.color = '#7c3aed';
            elements.manualSlider.style.display = 'none';
        } else {
            elements.manualModeBtn.style.borderColor = '#7c3aed';
            elements.manualModeBtn.style.background = 'rgba(124, 58, 237, 0.15)';
            elements.manualModeBtn.style.color = '#7c3aed';
            elements.autoModeBtn.style.borderColor = '#3f3f46';
            elements.autoModeBtn.style.background = 'transparent';
            elements.autoModeBtn.style.color = '#9ca3af';
            elements.modeDescription.textContent = 'Target: ~' + elements.tabsPerGroup.value + ' tabs per group';
            elements.modeDescription.style.color = '#9ca3af';
            elements.manualSlider.style.display = 'block';
        }
    }

    // Update description when slider changes
    elements.tabsPerGroup.addEventListener('input', () => {
        if (currentMode === 'manual') {
            elements.modeDescription.textContent = 'Target: ~' + elements.tabsPerGroup.value + ' tabs per group';
        }
    });

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

    /**
     * Main function to organize tabs using AI
     */
    async function organizeTabs() {
        showProcessing();
        
        try {
            // Send message to background script with mode info
            const response = await api.runtime.sendMessage({
                action: 'organizeTabs',
                mode: currentMode,
                tabsPerGroup: currentMode === 'manual' ? parseInt(elements.tabsPerGroup.value) : null
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