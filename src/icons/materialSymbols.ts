import { addCollection } from "@iconify/react";
import materialSymbols from "@iconify-json/material-symbols/icons.json";
import simpleIcons from "@iconify-json/simple-icons/icons.json";

// Registers the Material Symbols collection so <Icon icon="material-symbols:..."/> works offline.
addCollection(materialSymbols as any);
// Registers Simple Icons collection for brand/system icons like simple-icons:linux.
addCollection(simpleIcons as any);
