// Popup UI controller for Tab Wrapper extension
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
        sliderValue: document.getElementById('sliderValue')
    };

    // Load initial state
    await loadTabCount();
    resetToInitial();

    // Slider listener
    elements.tabsPerGroup.addEventListener('input', (e) => {
        elements.sliderValue.textContent = e.target.value;
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
            const tabs = await chrome.tabs.query({ currentWindow: true });
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
            // Send message to background script
            const response = await chrome.runtime.sendMessage({
                action: 'organizeTabs',
                tabsPerGroup: elements.tabsPerGroup.value
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
    chrome.tabs.onCreated.addListener(loadTabCount);
    chrome.tabs.onRemoved.addListener(loadTabCount);
});