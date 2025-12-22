/**
 * Basic protection against casual inspection
 * Note: Determined users can still bypass this
 */


(function() {
    'use strict';
    
    // Disable right-click
    document.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        return false;
    });
    
    // Disable F12, Ctrl+Shift+I, Ctrl+Shift+J, Ctrl+U
    document.addEventListener('keydown', function(e) {
        // F12
        if (e.key === 'F12') {
            e.preventDefault();
            return false;
        }
        
        // Ctrl+Shift+I (Inspector)
        if (e.ctrlKey && e.shiftKey && e.key === 'I') {
            e.preventDefault();
            return false;
        }
        
        // Ctrl+Shift+J (Console)
        if (e.ctrlKey && e.shiftKey && e.key === 'J') {
            e.preventDefault();
            return false;
        }
        
        // Ctrl+Shift+C (Element selector)
        if (e.ctrlKey && e.shiftKey && e.key === 'C') {
            e.preventDefault();
            return false;
        }
        
        // Ctrl+U (View source)
        if (e.ctrlKey && e.key === 'u') {
            e.preventDefault();
            return false;
        }
        
        // Ctrl+S (Save page)
        if (e.ctrlKey && e.key === 's') {
            e.preventDefault();
            return false;
        }
    });
    
    // Detect DevTools opening
    let devtoolsOpen = false;
    const threshold = 160;
    
    setInterval(function() {
        if (window.outerWidth - window.innerWidth > threshold || 
            window.outerHeight - window.innerHeight > threshold) {
            if (!devtoolsOpen) {
                devtoolsOpen = true;
                // Redirect or show warning
                document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:Arial;flex-direction:column;"><h1>⚠️ Access Denied</h1><p>Developer tools are not allowed on this site.</p></div>';
            }
        } else {
            devtoolsOpen = false;
        }
    }, 500);
    
    // Disable text selection
    document.addEventListener('selectstart', function(e) {
        e.preventDefault();
        return false;
    });
    
    // Disable copy
    document.addEventListener('copy', function(e) {
        e.preventDefault();
        return false;
    });
    
    // Disable cut
    document.addEventListener('cut', function(e) {
        e.preventDefault();
        return false;
    });
    
    // Clear console periodically
    setInterval(function() {
        console.clear();
    }, 1000);
    
    // Override console methods
    if (window.console) {
        const noop = function() {};
        ['log', 'debug', 'info', 'warn', 'error'].forEach(method => {
            console[method] = noop;
        });
    }
    
})();



