/**
 * @module components/custom-editor
 * Extended editor with custom keybindings for OrionOmega TUI.
 */

import { Editor, Key, matchesKey } from '@mariozechner/pi-tui';

export class CustomEditor extends Editor {
  onEscape?: () => void;
  onCtrlC?: () => void;
  onCtrlD?: () => void;

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) && this.onEscape && !this.isShowingAutocomplete()) {
      this.onEscape();
      return;
    }
    if (matchesKey(data, Key.ctrl('c')) && this.onCtrlC) {
      this.onCtrlC();
      return;
    }
    if (matchesKey(data, Key.ctrl('d'))) {
      if (this.getText().length === 0 && this.onCtrlD) {
        this.onCtrlD();
      }
      return;
    }
    super.handleInput(data);
  }
}
