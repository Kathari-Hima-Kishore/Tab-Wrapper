/**
 * Cross-browser API polyfill
 * Provides a unified 'browser' namespace that works across:
 * - Chrome, Edge, Brave (using chrome.* namespace)
 * - Firefox (using native browser.* namespace)
 */

(function() {
    'use strict';

    // If browser namespace already exists (Firefox), use it
    if (typeof globalThis.browser !== 'undefined') {
        globalThis.crossBrowser = globalThis.browser;
        return;
    }

    // Otherwise, create a Promise-based wrapper around chrome.* APIs
    const wrapAPI = (api) => {
        return new Proxy(api, {
            get(target, prop) {
                const value = target[prop];
                
                // If it's an object (like tabs, windows, etc.), wrap it
                if (typeof value === 'object' && value !== null) {
                    return wrapAPI(value);
                }
                
                // If it's a function, make it return a Promise
                if (typeof value === 'function') {
                    return function(...args) {
                        return new Promise((resolve, reject) => {
                            const callback = (result) => {
                                const lastError = chrome.runtime.lastError;
                                if (lastError) {
                                    reject(new Error(lastError.message));
                                } else {
                                    resolve(result);
                                }
                            };
                            
                            // Handle methods that don't expect a callback
                            try {
                                const result = value.apply(target, args.concat([callback]));
                                
                                // Some APIs return the result directly (like sendMessage might)
                                if (result !== undefined && typeof result.then === 'function') {
                                    result.then(resolve, reject);
                                }
                            } catch (err) {
                                reject(err);
                            }
                        });
                    };
                }
                
                return value;
            }
        });
    };

    // Create the browser namespace as a Promise-based wrapper
    globalThis.crossBrowser = wrapAPI(chrome);
    
    // Also expose as 'browser' for compatibility with Firefox-first code
    if (typeof globalThis.browser === 'undefined') {
        globalThis.browser = globalThis.crossBrowser;
    }
})();
