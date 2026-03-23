// Background service worker for Tab Wrapper extension
// Handles tab collection and calls the Vercel backend for organization

const BACKEND_URL = 'https://tab-wrapper-e12sj741o-khks-projects-0ec29871.vercel.app/api/organize';

// Listen for messages from popup, check
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
        return true;
    }
});

async function organizeTabsWithAI() {
    console.log('Tab Wrapper: Starting organizeTabsWithAI');
    
    try {
        // Step 1: Get tabs from the last focused normal window
        let targetWindow;
        try {
            targetWindow = await chrome.windows.getLastFocused({ populate: true });
            console.log('Tab Wrapper: Window type:', targetWindow.type, 'id:', targetWindow.id);
        } catch (e) {
            console.warn('Tab Wrapper: Could not get last focused window:', e.message);
        }
        
        if (!targetWindow || targetWindow.type.trim() !== 'normal') {
            const windows = await chrome.windows.getAll({ populate: true });
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

        // Step 2: Call your Vercel Backend
        console.log('Tab Wrapper: Calling backend API...');
        let response;
        try {
            response = await fetch(BACKEND_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tabs: scriptableTabs.map(tab => ({
                        id: tab.id,
                        title: tab.title || 'Untitled',
                        url: tab.url
                    }))
                })
            });
        } catch (fetchError) {
            console.error('Tab Wrapper: Network error calling backend:', fetchError);
            throw new Error(`Connection to backend failed. Check your Vercel deployment.`);
        }

        const text = await response.text();
        let data;
        try {
            data = JSON.parse(text);
        } catch (parseError) {
            console.error('Tab Wrapper: Backend returned non-JSON response:', text);
            throw new Error(`Server returned HTML error. Please ensure Vercel deployment is finished.`);
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
        const groups = await chrome.tabGroups.query({ windowId: windowId });
        for (const group of groups) {
            const tabs = await chrome.tabs.query({ groupId: group.id });
            if (tabs.length > 0) {
                await chrome.tabs.ungroup(tabs.map(t => t.id));
            }
        }
    } catch (error) {
        console.warn('Tab Wrapper: Error clearing groups:', error);
    }
}

async function createTabGroups(groups, windowId) {
    const createdGroups = [];

    for (const group of groups) {
        if (!group.tabIds || group.tabIds.length < 2) continue;

        try {
            // Convert 1-based indices from backend back to actual tab IDs
            // Note: Our backend prompt asked for 1-based indices relative to the list sent
            // We need to fetch the current tabs again to be sure
            const currentTabs = await chrome.tabs.query({ windowId: windowId });
            const scriptableTabs = currentTabs.filter(tab => 
                tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))
            );

            const actualTabIds = group.tabIds
                .map(idx => scriptableTabs[idx - 1]?.id)
                .filter(id => id !== undefined);

            if (actualTabIds.length < 2) continue;

            console.log(`Tab Wrapper: Grouping into "${group.groupName}"`);

            const groupId = await chrome.tabs.group({ 
                tabIds: actualTabIds,
                createProperties: { windowId: windowId }
            });

            // Standardize color (API uses 'grey' instead of 'gray')
            let groupColor = (group.color || 'blue').toLowerCase();
            if (groupColor === 'gray') groupColor = 'grey';

            await chrome.tabGroups.update(groupId, {
                title: group.groupName,
                color: groupColor
            });

            createdGroups.push({ id: groupId, name: group.groupName });
        } catch (error) {
            console.error(`Tab Wrapper: Failed to create group "${group.groupName}":`, error.message);
        }
    }
    return createdGroups;
}