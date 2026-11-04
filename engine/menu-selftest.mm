#import <Cocoa/Cocoa.h>
#include <cstdint>

extern "C" int32_t nt_engine_menu_selftest(void) {
  for (NSMenuItem *top in NSApp.mainMenu.itemArray) {
    NSMenu *menu = top.submenu;
    for (NSInteger index = 0; index < menu.numberOfItems; index++) {
      NSMenuItem *item = [menu itemAtIndex:index];
      if (item.tag == 1 && item.enabled && [item.title isEqualToString:@"Change clear colour"]) {
        [menu performActionForItemAtIndex:index];
        return 1;
      }
    }
  }
  return 0;
}
