# Desktop compatibility

Platform: macOS arm64.

15 supported, 2 partial, 3 unsupported.

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
| multiple windows | no |  |
| window events | no |  |
| clipboard text | yes |  |
| open file/directory dialog | yes | synchronous native modal |
| save dialog | yes | synchronous native modal |
| open external URL | yes |  |
| notifications | different | submitted through deprecated NSUserNotification; delivery and permission behavior are not yet production-grade |
| application menu | yes | top-level menus, separators, command-key equivalents, enabled state, compiled callbacks |
| context menu | yes | separators, enabled state, and compiled callbacks; showContextMenu must run while macOS has a current UI event |
| tray/status item | yes | text, tooltip, file-backed template or color image, attached menu, enabled state, separators, and compiled callbacks |
| file associations | different | document types and URL schemes are registered in Info.plist; runtime open-file and open-URL event delivery is not implemented |
| global shortcuts | no |  |

Generated from `desktop/surface.json`; do not edit directly.
