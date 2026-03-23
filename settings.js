// Settings page controller for Tab Wrapper extension
document.addEventListener('DOMContentLoaded', async () => {
    // Get DOM elements
    const elements = {
        apiKey: document.getElementById('apiKey'),
        toggleVisibility: document.getElementById('toggleVisibility'),
        saveButton: document.getElementById('saveButton'),
        clearButton: document.getElementById('clearButton'),
        keyStatus: document.getElementById('keyStatus'),
        toast: document.getElementById('toast'),
        toastMessage: document.getElementById('toastMessage'),
        closeSettings: document.getElementById('closeSettings')
    };

    let isApiKeyVisible = false;

    // Load current API key
    await loadApiKey();

    // Event listeners
    elements.toggleVisibility.addEventListener('click', toggleApiKeyVisibility);
    elements.saveButton.addEventListener('click', saveApiKey);
    elements.clearButton.addEventListener('click', clearApiKey);
    elements.apiKey.addEventListener('input', handleApiKeyInput);
    elements.closeSettings.addEventListener('click', closeSettingsWindow);

    /**
     * Load and display the current API key
     */
    async function loadApiKey() {
        try {
            const result = await chrome.storage.local.get(['geminiApiKey']);
            const apiKey = result.geminiApiKey || '';
            
            if (apiKey) {
                elements.apiKey.value = apiKey;
                updateKeyStatus(true);
            } else {
                updateKeyStatus(false);
            }
        } catch (error) {
            console.error('Error loading API key:', error);
            showToast('Error loading saved API key', true);
        }
    }

    /**
     * Toggle API key visibility
     */
    function toggleApiKeyVisibility() {
        isApiKeyVisible = !isApiKeyVisible;
        
        if (isApiKeyVisible) {
            elements.apiKey.type = 'text';
            elements.toggleVisibility.textContent = 'Hide';
        } else {
            elements.apiKey.type = 'password';
            elements.toggleVisibility.textContent = 'Show';
        }
    }

    /**
     * Save API key to chrome.storage.local
     */
    async function saveApiKey() {
        const apiKey = elements.apiKey.value.trim();
        
        // Validate API key
        if (!apiKey) {
            showToast('Please enter an API key', true);
            return;
        }

        if (!isValidApiKey(apiKey)) {
            showToast('Invalid API key format. Must start with "AIza..."', true);
            return;
        }

        try {
            await chrome.storage.local.set({ geminiApiKey: apiKey });
            updateKeyStatus(true);
            showToast('API key saved successfully!');
            
            // Test the API key with a simple request
            await testApiKey(apiKey);
            
        } catch (error) {
            console.error('Error saving API key:', error);
            showToast('Error saving API key', true);
        }
    }

    /**
     * Clear API key from storage
     */
    async function clearApiKey() {
        if (!elements.apiKey.value.trim()) {
            showToast('No API key to clear', true);
            return;
        }

        try {
            await chrome.storage.local.remove(['geminiApiKey']);
            elements.apiKey.value = '';
            updateKeyStatus(false);
            showToast('API key cleared successfully');
        } catch (error) {
            console.error('Error clearing API key:', error);
            showToast('Error clearing API key', true);
        }
    }

    /**
     * Handle API key input changes
     */
    function handleApiKeyInput() {
        const apiKey = elements.apiKey.value.trim();
        
        // Update button states
        elements.saveButton.disabled = !apiKey;
        elements.clearButton.disabled = !apiKey;
        
        // Update status indicator
        if (apiKey) {
            const isValid = isValidApiKey(apiKey);
            if (isValid) {
                updateKeyStatus(false, 'Valid format');
            } else {
                updateKeyStatus(false, 'Invalid format');
            }
        } else {
            updateKeyStatus(false);
        }
    }

    /**
     * Validate API key format
     */
    function isValidApiKey(apiKey) {
        // Gemini API keys start with "AIza" and are typically 39 characters long
        return /^AIza[A-Za-z0-9_-]{35}$/.test(apiKey);
    }

    /**
     * Test API key with a simple Gemini API request
     */
    async function testApiKey(apiKey) {
        try {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                }
            });

            if (!response.ok) {
                if (response.status === 401) {
                    throw new Error('Invalid API key');
                } else if (response.status === 429) {
                    throw new Error('API rate limit exceeded');
                } else {
                    throw new Error(`API test failed: ${response.status}`);
                }
            }

            // If we get here, the API key is valid
            console.log('API key test successful');
            
        } catch (error) {
            console.error('API key test failed:', error);
            
            // Remove the invalid key
            await chrome.storage.local.remove(['geminiApiKey']);
            elements.apiKey.value = '';
            updateKeyStatus(false);
            
            if (error.message.includes('Invalid API key')) {
                showToast('Invalid API key. Please check and try again.', true);
            } else if (error.message.includes('rate limit')) {
                showToast('API rate limit exceeded. Please wait and try again.', true);
            } else {
                showToast('API key validation failed. Please try again.', true);
            }
        }
    }

    /**
     * Update key status indicator
     */
    function updateKeyStatus(isSet, customMessage = null) {
        const statusIndicator = elements.keyStatus;
        
        if (isSet) {
            statusIndicator.className = 'status-indicator set';
            statusIndicator.innerHTML = `
                <span class="status-dot"></span>
                <span>API key configured</span>
            `;
        } else {
            statusIndicator.className = 'status-indicator not-set';
            const message = customMessage || 'No API key set';
            statusIndicator.innerHTML = `
                <span class="status-dot"></span>
                <span>${message}</span>
            `;
        }
    }

    /**
     * Show toast notification
     */
    function showToast(message, isError = false) {
        elements.toastMessage.textContent = message;
        
        if (isError) {
            elements.toast.className = 'toast error';
            // Update icon for error
            elements.toast.innerHTML = `
                <svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="15" y1="9" x2="9" y2="15"/>
                    <line x1="9" y1="9" x2="15" y2="15"/>
                </svg>
                <span id="toastMessage">${message}</span>
            `;
        } else {
            elements.toast.className = 'toast';
            // Update icon for success
            elements.toast.innerHTML = `
                <svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M20 6L9 17l-5-5"/>
                </svg>
                <span id="toastMessage">${message}</span>
            `;
        }
        
        // Show toast
        setTimeout(() => {
            elements.toast.classList.add('show');
        }, 100);
        
        // Hide toast after 3 seconds
        setTimeout(() => {
            elements.toast.classList.remove('show');
        }, 3000);
    }

    /**
     * Handle keyboard shortcuts
     */
    document.addEventListener('keydown', (event) => {
        // Ctrl/Cmd + S to save
        if ((event.ctrlKey || event.metaKey) && event.key === 's') {
            event.preventDefault();
            saveApiKey();
        }
        
        // Escape to clear
        if (event.key === 'Escape') {
            clearApiKey();
        }
    });

    /**
     * Handle form submission
    */
    elements.apiKey.addEventListener('keypress', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            saveApiKey();
        }
    });

    // Initialize button states
    handleApiKeyInput();

    /**
     * Close the settings window
     */
    function closeSettingsWindow() {
        window.close();
    }
});
