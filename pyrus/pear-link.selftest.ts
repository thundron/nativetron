import { isPearLink, parsePearLink, validatePearKey } from "./pear-link.js";

function rejected(value: unknown, message: string): boolean {
  try {
    parsePearLink(value);
  } catch (error) {
    return error instanceof Error && error.message === message;
  }
  return false;
}

function main(): void {
  const z32 = "y".repeat(52);
  const hex = "a".repeat(64);
  const stable = parsePearLink("pear://" + z32);
  const versioned = parsePearLink("pear://12.345." + hex);
  const path = parsePearLink("pear://" + z32 + "/folder/caf%C3%A9#section%20one");
  const hash = parsePearLink("pear://" + z32 + "#%23fragment");
  const ok = stable.kind === "stable" && stable.baseKind === "stable" && stable.key === z32
    && stable.fork === null && stable.path === null
    && versioned.kind === "versioned" && versioned.baseKind === "versioned"
    && versioned.fork === 12 && versioned.length === 345 && versioned.key === hex
    && path.kind === "hash" && path.baseKind === "stable" && path.path === "/folder/café"
    && path.pathSegments.join("|") === "folder|café" && path.hash === "section one"
    && hash.kind === "hash" && hash.hash === "#fragment"
    && validatePearKey(hex) === hex && isPearLink(stable.canonical) && !isPearLink("https://example.com")
    && rejected("pear://" + z32 + "/", "Pear link path is invalid")
    && rejected("pear://" + z32 + "/..", "Pear link path segment is unsafe")
    && rejected("pear://" + z32 + "/a%2Fb", "Pear link path segment is unsafe")
    && rejected("pear://" + z32 + "/%zz", "Pear link path encoding is invalid")
    && rejected("pear://" + z32 + "?x=1", "Invalid Pear link")
    && rejected("pear://" + z32 + "##x", "Pear link hash is invalid")
    && rejected("pear://1.9999999999999999." + hex, "Pear link version is outside the supported range")
    && rejected("pear://" + "A".repeat(64), "Pear key is invalid")
    && rejected("pear://" + z32 + "/bad\npath", "Invalid Pear link");
  console.log(ok ? "PYRUS_PEAR_LINK=OK" : "PYRUS_PEAR_LINK=FAIL");
  if (!ok) process.exit(1);
}

main();
