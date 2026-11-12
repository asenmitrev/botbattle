import { EditorView, basicSetup } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";

/** CodeMirror 6 JS editor. Ctrl/Cmd+Enter runs the match. */
export function createEditor(parent: HTMLElement, doc: string, onChange: (code: string) => void, onRun: () => void): EditorView {
  parent.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        onRun();
      }
    },
    true,
  );
  return new EditorView({
    parent,
    doc,
    extensions: [
      basicSetup,
      javascript(),
      oneDark,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) onChange(u.state.doc.toString());
      }),
    ],
  });
}
