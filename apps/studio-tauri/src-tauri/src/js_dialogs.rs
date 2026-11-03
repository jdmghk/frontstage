//! window.alert, confirm and prompt on macOS. wry's WKUIDelegate doesn't implement these panels, so
//! WebKit answers them silently (confirm is false, prompt is null), and the editor's delete
//! confirmations and timeline rename would quietly do nothing. WebView2 and WebKitGTK show their own
//! dialogs, so this is macOS only.

#![cfg(target_os = "macos")]

use std::ffi::CString;
use std::ptr::NonNull;

use block2::Block;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, ProtocolObject, Sel};
use objc2::{sel, MainThreadMarker};
#[cfg(not(feature = "webkit-tests"))]
use objc2_app_kit::{NSAlert, NSTextField};
#[cfg(not(feature = "webkit-tests"))]
use objc2_foundation::{NSPoint, NSRect, NSSize};
use objc2_foundation::NSString;
use objc2_web_kit::{WKUIDelegate, WKWebView};

#[cfg(feature = "webkit-tests")]
pub mod scripted {
    //! Automated runs must never show a window, so panels answer themselves and are recorded.
    use std::sync::Mutex;
    pub static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
    pub fn record(kind: &str, message: &str) {
        LOG.lock().unwrap().push(format!("{kind}: {message}"));
    }
}

#[cfg(not(feature = "webkit-tests"))]
fn alert(message: &NSString, mtm: MainThreadMarker, buttons: &[&str], field: Option<&NSTextField>) -> isize {
    let a = NSAlert::new(mtm);
    a.setMessageText(message);
    for b in buttons {
        a.addButtonWithTitle(&NSString::from_str(b));
    }
    if let Some(f) = field {
        a.setAccessoryView(Some(f));
    }
    a.runModal()
}

// NSAlertFirstButtonReturn.
#[cfg(not(feature = "webkit-tests"))]
const FIRST_BUTTON: isize = 1000;

unsafe extern "C-unwind" fn run_alert(_this: *mut AnyObject, _cmd: Sel, _wv: *mut AnyObject, message: NonNull<NSString>, _frame: *mut AnyObject, done: NonNull<Block<dyn Fn()>>) {
    #[cfg(feature = "webkit-tests")]
    {
        scripted::record("alert", &unsafe { message.as_ref() }.to_string());
        unsafe { done.as_ref() }.call(());
    }
    #[cfg(not(feature = "webkit-tests"))]
    {
        if let Some(mtm) = MainThreadMarker::new() {
            alert(unsafe { message.as_ref() }, mtm, &["OK"], None);
        }
        unsafe { done.as_ref() }.call(());
    }
}

unsafe extern "C-unwind" fn run_confirm(_this: *mut AnyObject, _cmd: Sel, _wv: *mut AnyObject, message: NonNull<NSString>, _frame: *mut AnyObject, done: NonNull<Block<dyn Fn(Bool)>>) {
    #[cfg(feature = "webkit-tests")]
    {
        scripted::record("confirm", &unsafe { message.as_ref() }.to_string());
        unsafe { done.as_ref() }.call((Bool::YES,));
    }
    #[cfg(not(feature = "webkit-tests"))]
    {
        let ok = MainThreadMarker::new().is_some_and(|mtm| alert(unsafe { message.as_ref() }, mtm, &["OK", "Cancel"], None) == FIRST_BUTTON);
        unsafe { done.as_ref() }.call((Bool::new(ok),));
    }
}

unsafe extern "C-unwind" fn run_prompt(_this: *mut AnyObject, _cmd: Sel, _wv: *mut AnyObject, message: NonNull<NSString>, default: *mut NSString, _frame: *mut AnyObject, done: NonNull<Block<dyn Fn(*mut NSString)>>) {
    #[cfg(feature = "webkit-tests")]
    {
        scripted::record("prompt", &unsafe { message.as_ref() }.to_string());
        let answer: Retained<NSString> = NSString::from_str("scripted answer");
        unsafe { done.as_ref() }.call((Retained::as_ptr(&answer) as *mut NSString,));
        let _ = default;
    }
    #[cfg(not(feature = "webkit-tests"))]
    {
        let Some(mtm) = MainThreadMarker::new() else {
            unsafe { done.as_ref() }.call((std::ptr::null_mut(),));
            return;
        };
        let field = NSTextField::initWithFrame(mtm.alloc(), NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(280.0, 24.0)));
        if let Some(d) = unsafe { default.as_ref() } {
            field.setStringValue(d);
        }
        if alert(unsafe { message.as_ref() }, mtm, &["OK", "Cancel"], Some(&field)) == FIRST_BUTTON {
            let v = field.stringValue();
            unsafe { done.as_ref() }.call((Retained::as_ptr(&v) as *mut NSString,));
        } else {
            unsafe { done.as_ref() }.call((std::ptr::null_mut(),));
        }
    }
}

unsafe fn add(cls: &AnyClass, name: Sel, imp: Imp, types: &str) {
    let types = CString::new(types).expect("no NUL");
    // false means the class already has it: then wry has grown its own, and that one stays.
    let _ = unsafe { objc2::ffi::class_addMethod(cls as *const AnyClass as *mut AnyClass, name, imp, types.as_ptr()) };
}

/// Adds the three panel methods to wry's delegate class, then sets the delegate again because
/// WebKit reads which methods a delegate answers when it's set.
pub fn install(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    window.with_webview(|wv| unsafe {
        let webview: &WKWebView = &*(wv.inner() as *const WKWebView);
        let Some(delegate) = webview.UIDelegate() else { return };
        let cls = AnyObject::class(&*(Retained::as_ptr(&delegate) as *const AnyObject));
        add(cls, sel!(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:), std::mem::transmute::<*const (), Imp>(run_alert as *const ()), "v@:@@@@?");
        add(cls, sel!(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:), std::mem::transmute::<*const (), Imp>(run_confirm as *const ()), "v@:@@@@?");
        add(cls, sel!(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:), std::mem::transmute::<*const (), Imp>(run_prompt as *const ()), "v@:@@@@@?");
        let d: &ProtocolObject<dyn WKUIDelegate> = &delegate;
        webview.setUIDelegate(Some(d));
    })
}
