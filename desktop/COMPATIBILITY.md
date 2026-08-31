# Desktop compatibility

Platform: macOS arm64.

12 supported, 1 partial, 7 unsupported.

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
| application menu | no |  |
| context menu | no |  |
| tray/status item | no |  |
| file associations | no |  |
| global shortcuts | no |  |

Generated from `desktop/surface.json`; do not edit directly.
