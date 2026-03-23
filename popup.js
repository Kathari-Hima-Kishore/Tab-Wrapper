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
        errorDetail: document.getElementById('errorDetail')
    };

    // Load initial state
    await loadTabCount();
    await checkApiKey();
    resetToInitial(); // Always start with initial state

    // Event listeners
    elements.organizeButton.addEventListener('click', organizeTabs);
    elements.organizeAgainButton.addEventListener('click', organizeTabs);
    elements.retryButton.addEventListener('click', organizeTabs);
    document.getElementById('settingsLink').addEventListener('click', openSettingsPopup);

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
     * Check if API key is set and show appropriate UI
     */
    async function checkApiKey() {
        try {
            const result = await chrome.storage.local.get(['geminiApiKey']);
            const hasApiKey = !!result.geminiApiKey;
            
            if (!hasApiKey) {
                showError(
                    'API Key Required',
                    'Please set your Gemini API key in settings to get started.',
                    true
                );
            }
        } catch (error) {
            console.error('Error checking API key:', error);
        }
    }

    /**
     * Main function to organize tabs using AI
     */
    async function organizeTabs() {
        console.log('Tab Wrapper: organizeTabs called');
        showProcessing();
        
        try {
            console.log('Tab Wrapper: Sending message to background script');
            
            // Send message to background script (no timeout)
            const response = await chrome.runtime.sendMessage({
                action: 'organizeTabs'
            });

            console.log('Tab Wrapper: Received response:', response);

            if (response.success) {
                showSuccess(
                    'Tabs organized successfully!',
                    `Created ${response.groupCount} smart groups`
                );
            } else {
                showError(
                    'Organization Failed',
                    response.error || 'An unknown error occurred',
                    response.needsApiKey
                );
            }
        } catch (error) {
            console.error('Tab Wrapper: Error organizing tabs:', error);
            showError(
                'Communication Error',
                error.message || 'Could not connect to background service. Please try again.',
                false
            );
        }
    }

    /**
     * Show processing state with loading spinner
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
    function showError(title, detail, needsApiKey = false) {
        hideAllStates();
        elements.errorState.style.display = 'block';
        
        elements.errorText.textContent = title;
        
        if (needsApiKey) {
            elements.errorDetail.innerHTML = `
                ${detail}<br>
                <a href="#" id="settingsFromError" class="error-link">Open Settings →</a>
            `;
            document.getElementById('settingsFromError').addEventListener('click', (e) => {
                e.preventDefault();
                openSettingsPopup(e);
            });
        } else {
            elements.errorDetail.textContent = detail;
        }
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

    /**
     * Open settings in a popup window
     */
    function openSettingsPopup(event) {
        event.preventDefault();
        
        chrome.windows.create({
            url: chrome.runtime.getURL('settings.html'),
            type: 'popup',
            width: 700,
            height: 600,
            focused: true
        });
    }

    // Handle tab count updates when popup is opened
    chrome.tabs.onCreated.addListener(loadTabCount);
    chrome.tabs.onRemoved.addListener(loadTabCount);
});
