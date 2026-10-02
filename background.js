// Background service worker for Tab Wrapper extension
// Handles tab collection and calls the Vercel backend for organization
// Cross-browser compatible: Chrome, Edge, Firefox, Brave

const BACKEND_URL = 'https://tab-wrapper-pboeynppt-khks-projects-0ec29871.vercel.app/api/organize';

// Cross-browser API wrapper
const api = typeof browser !== 'undefined' ? browser : chrome;

// Check if tabGroups API is available
const hasTabGroupsAPI = () => {
    return typeof api.tabGroups !== 'undefined' || typeof api.tabs.group !== 'undefined';
};

// Listen for messages from popup
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Tab Wrapper Background: Received message:', message);
    
    if (message.action === 'organizeTabs') {
        console.log('Tab Wrapper Background: Starting organizeTabsWithAI');
        organizeTabsWithAI().then(result => {
            console.log('Tab Wrapper Background: organizeTabsWithAI completed:', result);
            sendResponse(result);
        }).catch(error => {
            console.error('Tab Wrapper Background: Error in organizeTabsWithAI:', error);
            sendResponse({
                success: false,
                error: error.message || 'Internal error occurred while organizing tabs'
            });
        });
        return true; // Keep channel open for async response
    }
});

async function organizeTabsWithAI() {
    console.log('Tab Wrapper: Starting organizeTabsWithAI');

    try {
        // Step 1: Get tabs from the last focused normal window
        let targetWindow;
        try {
            targetWindow = await api.windows.getLastFocused({ populate: true });
            console.log('Tab Wrapper: Window type:', targetWindow.type, 'id:', targetWindow.id);
        } catch (e) {
            console.warn('Tab Wrapper: Could not get last focused window:', e.message);
        }
        
        if (!targetWindow || targetWindow.type.trim() !== 'normal') {
            const windows = await api.windows.getAll({ populate: true });
            const normalWindow = windows.find(w => w.type && w.type.trim() === 'normal');
            if (normalWindow) targetWindow = normalWindow;
        }
        
        if (!targetWindow) {
            throw new Error('Could not find a normal browser window');
        }
        
        const tabs = targetWindow.tabs || [];
        const scriptableTabs = tabs.filter(tab => 
            tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))
        );

        if (scriptableTabs.length < 2) {
            return {
                success: false,
                error: 'Need at least 2 web pages to organize.'
            };
        }

        // Step 2: Call your Vercel Backend (This hides the API key and model selection)
        console.log('Tab Wrapper: Calling backend API...');

        const payload = JSON.stringify({
            tabs: scriptableTabs.map(tab => ({
                id: tab.id,
                title: tab.title || 'Untitled',
                url: tab.url
            }))
        });

        // A cold serverless start can drop the first outbound call. Retry once
        // before surfacing anything, so the user never sees a spurious failure.
        let response;
        let data;
        const maxAttempts = 2;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                response = await fetch(BACKEND_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: payload
                });
            } catch (fetchError) {
                console.error(`Tab Wrapper: Network error on attempt ${attempt}:`, fetchError);
                if (attempt < maxAttempts) {
                    await new Promise(r => setTimeout(r, 1200));
                    continue;
                }
                throw new Error('Connection to backend failed. Check your Vercel deployment.');
            }

            const raw = await response.text();
            try {
                data = JSON.parse(raw);
            } catch (parseError) {
                console.error('Tab Wrapper: Backend returned non-JSON response:', raw);
                throw new Error('Server returned HTML error. Please ensure Vercel deployment is finished.');
            }

            // Retry transient server-side failures (503, 502, 504, 429)
            const transient = [429, 502, 503, 504].includes(response.status);
            if (transient && attempt < maxAttempts) {
                console.warn(`Tab Wrapper: Backend returned ${response.status}, retrying...`);
                await new Promise(r => setTimeout(r, 1500));
                continue;
            }
            break;
        }

        if (!response.ok) {
            throw new Error(data.error || `Backend error: ${response.status}`);
        }

        if (!data.success || !data.groups) {
            throw new Error(data.error || 'Failed to get groups from backend');
        }

        // Step 3: Clear existing groups and create new ones
        await clearExistingGroups(targetWindow.id);
        const createdGroups = await createTabGroups(data.groups, targetWindow.id);
        
        return {
            success: true,
            groupCount: createdGroups.length,
            message: `Created ${createdGroups.length} tab groups`
        };

    } catch (error) {
        console.error('Tab Wrapper: Error:', error);
        return { success: false, error: error.message || 'Unknown error.' };
    }
}

async function clearExistingGroups(windowId) {
    try {
        // Check if tabGroups API is available
        if (!hasTabGroupsAPI()) {
            console.warn('Tab Wrapper: tabGroups API not available on this browser');
            return;
        }
        
        const groups = await api.tabGroups.query({ windowId: windowId });
        for (const group of groups) {
            const tabs = await api.tabs.query({ groupId: group.id });
            if (tabs.length > 0) {
                await api.tabs.ungroup(tabs.map(t => t.id));
            }
        }
    } catch (error) {
        console.warn('Tab Wrapper: Error clearing groups:', error);
    }
}

async function createTabGroups(groups, windowId) {
    const createdGroups = [];

    // Check if tabGroups API is available
    if (!hasTabGroupsAPI()) {
        console.error('Tab Wrapper: tabGroups API not available on this browser');
        return createdGroups;
    }

    // Fetch current tabs for the target window to ensure correct mapping
    const currentTabs = await api.tabs.query({ windowId: windowId });
    const scriptableTabs = currentTabs.filter(tab => 
        tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))
    );

    for (const group of groups) {
        if (!group.tabIds || group.tabIds.length === 0) continue;

        try {
            // Map 1-based indices to actual tab IDs
            const actualTabIds = group.tabIds
                .map(idx => scriptableTabs[idx - 1]?.id)
                .filter(id => id !== undefined);

            if (actualTabIds.length === 0) continue;

            console.log(`Tab Wrapper: Grouping ${actualTabIds.length} tab(s) into "${group.groupName}"`);

            const groupId = await api.tabs.group({ 
                tabIds: actualTabIds,
                createProperties: { windowId: windowId }
            });

            // Use whatever colour Gemini chose. Chrome only accepts its own
            // palette, so normalise the spelling and fall back to the browser
            // default if the model returned something unrecognised.
            const CHROME_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
            let groupColor = String(group.color || '').toLowerCase().trim();
            if (groupColor === 'gray') groupColor = 'grey';

            const update = { title: group.groupName };
            if (CHROME_COLORS.includes(groupColor)) {
                update.color = groupColor;
            }

            await api.tabGroups.update(groupId, update);

            createdGroups.push({ id: groupId, name: group.groupName });
        } catch (error) {
            console.error(`Tab Wrapper: Failed to create group "${group.groupName}":`, error.message);
        }
    }
    return createdGroups;
}