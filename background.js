// Background service worker for Tab Wrapper extension
// Handles tab collection, Gemini API calls, and tab group creation

// Listen for messages from popup
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
                error: 'Internal error occurred while organizing tabs'
            });
        });
        return true;
    }
});

async function organizeTabsWithAI() {
    console.log('Tab Wrapper: Starting organizeTabsWithAI');
    
    try {
        // Step 1: Get API key
        const apiKey = await getApiKey();
        if (!apiKey) {
            return {
                success: false,
                error: 'No Gemini API key found. Please set it in settings.',
                needsApiKey: true
            };
        }

        // Step 2: Get tabs from normal window - get window WITH tabs populated
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
        
        // Use tabs from the window object directly
        const tabs = targetWindow.tabs || [];
        console.log('Tab Wrapper: Found', tabs.length, 'tabs in window', targetWindow.id);
        
        const scriptableTabs = tabs.filter(tab => 
            tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))
        );
        console.log('Tab Wrapper: Scriptable tabs:', scriptableTabs.length);

        if (scriptableTabs.length < 2) {
            return {
                success: false,
                error: 'Need at least 2 web pages to organize.'
            };
        }

        // Step 3: Extract content
        const tabsWithContent = await extractTabContent(scriptableTabs);

        // Step 4: Call Gemini API
        const groups = await callGeminiAPI(apiKey, tabsWithContent);
        console.log('Tab Wrapper: Gemini response:', groups);

        // Step 5: Validate groups
        const validGroups = validateGroups(groups, scriptableTabs);
        console.log('Tab Wrapper: Valid groups:', validGroups);

        // Step 6: Clear existing groups and create new ones
        await clearExistingGroups(targetWindow.id);
        const createdGroups = await createTabGroups(validGroups, targetWindow.id, scriptableTabs);
        
        return {
            success: true,
            groupCount: createdGroups.length,
            message: `Created ${createdGroups.length} tab groups`
        };

    } catch (error) {
        console.error('Tab Wrapper: Error:', error);
        
        if (error.message.includes('401')) {
            return { success: false, error: 'Invalid API key.', needsApiKey: true };
        } else if (error.message.includes('429')) {
            return { success: false, error: 'API rate limit exceeded.' };
        } else if (error.message.includes('JSON')) {
            return { success: false, error: 'AI response was malformed.' };
        } else {
            return { success: false, error: error.message || 'Unknown error.' };
        }
    }
}

async function getApiKey() {
    try {
        const result = await chrome.storage.local.get(['geminiApiKey']);
        return result.geminiApiKey || null;
    } catch (error) {
        console.error('Tab Wrapper: Error getting API key:', error);
        return null;
    }
}

async function extractTabContent(tabs) {
    return tabs.map(tab => ({
        id: tab.id,
        windowId: tab.windowId,
        title: tab.title || 'Untitled',
        url: tab.url
    }));
}

async function callGeminiAPI(apiKey, tabs) {
    const prompt = buildGeminiPrompt(tabs);
    
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
            contents: [{
                parts: [{ text: prompt }]
            }]
        })
    });

    if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    
    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
        throw new Error('Invalid response from Gemini API');
    }

    const text = data.candidates[0].content.parts[0].text;
    console.log('Tab Wrapper: Response text:', text);
    
    try {
        let cleanText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const jsonMatch = cleanText.match(/\[[\s\S]*\]/);
        if (jsonMatch) cleanText = jsonMatch[0];
        return JSON.parse(cleanText);
    } catch (error) {
        console.error('Tab Wrapper: JSON parse error:', text);
        throw new Error('Invalid JSON response from Gemini API');
    }
}

function buildGeminiPrompt(tabs) {
    const tabsData = tabs.map((tab, index) => {
        return `${index + 1}. "${tab.title}" - ${tab.url}`;
    }).join('\n');

    return `Group these ${tabs.length} tabs into 2-3 groups. Reply ONLY with JSON array:

[{"groupName":"Name","color":"blue","tabIds":[1,2]}]

Tabs:
${tabsData}

Colors: blue,red,yellow,green,pink,purple,cyan,orange
tabIds: 1-${tabs.length}`;
}

function validateGroups(groups, tabs) {
    if (!Array.isArray(groups)) {
        throw new Error('Gemini did not return an array of groups');
    }

    const validGroups = [];
    const usedTabIds = new Set();
    const validColors = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

    for (const group of groups) {
        if (!group.groupName || !group.color || !Array.isArray(group.tabIds)) continue;
        
        let color = group.color.toLowerCase();
        if (color === 'gray') color = 'grey';
        if (!validColors.includes(color)) color = 'blue';

        const validTabIds = [];
        for (const tabIndex of group.tabIds) {
            if (typeof tabIndex === 'number' && tabIndex >= 1 && tabIndex <= tabs.length) {
                const tab = tabs[tabIndex - 1];
                const actualTabId = tab.id;
                if (!usedTabIds.has(actualTabId)) {
                    validTabIds.push(actualTabId);
                    usedTabIds.add(actualTabId);
                }
            }
        }

        if (validTabIds.length > 0) {
            validGroups.push({
                groupName: group.groupName,
                color: color,
                tabIds: validTabIds
            });
        }
    }

    // Add ungrouped tabs to an 'Other' group if any remain
    const ungroupedTabs = tabs.filter(tab => !usedTabIds.has(tab.id));
    if (ungroupedTabs.length > 0) {
        validGroups.push({
            groupName: 'Other',
            color: 'grey',
            tabIds: ungroupedTabs.map(tab => tab.id)
        });
    }

    return validGroups;
}

async function clearExistingGroups(windowId) {
    try {
        const groups = await chrome.tabGroups.query({ windowId: windowId });
        for (const group of groups) {
            try {
                const tabs = await chrome.tabs.query({ groupId: group.id });
                if (tabs.length > 0) {
                    await chrome.tabs.ungroup(tabs.map(t => t.id));
                }
            } catch (e) {
                console.warn(`Tab Wrapper: Could not ungroup group ${group.id}:`, e.message);
            }
        }
    } catch (error) {
        console.warn('Tab Wrapper: Error clearing groups:', error);
    }
}

async function createTabGroups(groups, windowId, tabs) {
    const createdGroups = [];

    try {
        const win = await chrome.windows.get(windowId);
        if (win.type.trim() !== 'normal') {
            throw new Error(`Window is ${win.type}, not normal`);
        }
    } catch (e) {
        console.error(`Tab Wrapper: Window verification failed: ${e.message}`);
        return [];
    }

    for (const group of groups) {
        if (group.tabIds.length === 0) continue;

        try {
            const currentTabs = await chrome.tabs.query({ windowId: windowId });
            const currentTabIds = new Set(currentTabs.map(t => t.id));
            const validTabIds = group.tabIds.filter(id => currentTabIds.has(id));

            if (validTabIds.length < 2) continue;

            console.log(`Tab Wrapper: Grouping ${validTabIds.length} tabs into "${group.groupName}"`);

            let groupId;
            try {
                // Strategy 1: Explicit windowId (Most successful in Edge)
                groupId = await chrome.tabs.group({ 
                    tabIds: validTabIds,
                    createProperties: { windowId: windowId }
                });
            } catch (error) {
                console.warn(`Tab Wrapper: Primary grouping failed: ${error.message}. Trying simple bulk group.`);
                try {
                    // Strategy 2: Simple bulk group
                    groupId = await chrome.tabs.group({ tabIds: validTabIds });
                } catch (error2) {
                    console.warn(`Tab Wrapper: Bulk group failed: ${error2.message}. Trying incremental.`);
                    // Strategy 3: Incremental group
                    groupId = await chrome.tabs.group({ tabIds: validTabIds[0] });
                    for (let i = 1; i < validTabIds.length; i++) {
                        await chrome.tabs.group({ tabIds: validTabIds[i], groupId: groupId });
                    }
                }
            }

            await chrome.tabGroups.update(groupId, {
                title: group.groupName,
                color: group.color
            });

            createdGroups.push({ id: groupId, name: group.groupName });
            console.log(`Tab Wrapper: Successfully created group "${group.groupName}"`);

        } catch (error) {
            console.error(`Tab Wrapper: Failed to create group "${group.groupName}":`, error.message);
        }
    }

    return createdGroups;
}
