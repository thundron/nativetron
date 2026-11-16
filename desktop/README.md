# Desktop compatibility

Platform: macOS arm64.

19 supported, 1 partial, 0 unsupported.

| capability | status | note |
|---|---|---|
| window title | yes |  |
| window size | yes |  |
| minimize | yes |  |
| maximize | yes |  |
| fullscreen | yes | toggle operation |
| show / hide / focus | yes |  |
| close | yes |  |
| window state | yes | minimized, maximized, visible, focused, fullscreen |
| multiple windows | different | secondary native webviews load explicit HTML or URLs and expose title, size, state, actions, events, and cleanup; they do not have independent compiled DOM Host ABI renderer roots |
| window events | yes | window id plus move, resize, minimize, restore, focus, blur, fullscreen enter/exit, and close from native NSWindow notifications |
| clipboard text | yes |  |
| open file/directory dialog | yes | synchronous native modal |
| save dialog | yes | synchronous native modal |
| open external URL | yes |  |
| notifications | yes | UserNotifications authorization is asynchronous and callbacks return on the compiled runtime pump; delivery requires a properly bundled and signed application identity |
| application menu | yes | top-level menus, separators, command-key equivalents, enabled state, compiled callbacks |
| context menu | yes | separators, enabled state, and compiled callbacks; showContextMenu must run while macOS has a current UI event |
| tray/status item | yes | text, tooltip, file-backed template or color image, attached menu, enabled state, separators, and compiled callbacks |
| file and URL associations | yes | Info.plist document types and URL schemes enter the compiled main process through Apple Events and are forwarded to renderer handlers over bounded IPC |
| global shortcuts | yes | letters, digits, and F1-F12 with command, option, control, and shift modifiers through native Carbon hotkeys |

Generated from `desktop/surface.json`; do not edit directly.
