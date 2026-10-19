# Responsive pickers

How provider, model and other selection panels size themselves and scroll in the terminal.

Provider and model selection use the shared `src/ui/panels/responsivePickerViewport.ts` calculation. The shell first budgets the measured header, panel stage, composer, runtime status, padding, and terminal gutter. Each picker then subtracts only the rows it actually renders inside that border-safe panel body, such as its title and optional metadata. The remaining rows are the list capacity; there is no fixed provider or model page size.

If the complete list fits, every entry is rendered and no overflow position is shown. Longer lists retain one continuous scroll offset, move it only enough to keep the selected entry visible, and display the useful current position (for example, `Models · 11/20`) instead of a page range or permanent “more” rows. Home and End select the first and last entry; Page Up and Page Down move by the current calculated capacity. Selection and offset are clamped when data or terminal dimensions change.

At 100×22 the picker keeps its border, composer, runtime status, and all available short-list provider rows visible. On terminals up to 24 rows, every open overlay—including Theme, Mode, Settings, Auth, provider, and model panels—switches the existing header identity to its one-line compact form and omits the redundant panel-close hint before sacrificing option rows. Wider terminals restore the full logo and provider metadata columns. Display-width-aware truncation keeps long Unicode or model names within the panel at narrow widths. Extremely small dimensions remain protected by the shell's cramped-terminal fallback and non-negative viewport clamps.

Auth uses an essential-only compact view at short heights: title, backend/auth state, probe summary, all three preferences, controls, and recommended next action. Settings option groups use bounded, non-wrapping rows so one setting cannot overwrite another during incremental terminal rendering.

Generic selection screens use the same responsive viewport as provider/model lists rather than `ink-select-input`'s fixed limit. Theme selection therefore renders all nine registered themes at 100×22, starts on the committed theme, previews a highlighted theme immediately, restores the committed theme on Escape, and persists it only on Enter. Mode, Backend, writable-root, and other `SelectionPanel` consumers inherit the same continuous scrolling and Home/End/Page navigation.

Implementation: `src/ui/panels/responsivePickerViewport.ts` (shared capacity calculation), `src/ui/panels/ProviderPicker.tsx`, `src/ui/panels/ModelPickerScreen.tsx`, `src/ui/chrome/AppShell.tsx`, and the panel-hint composition in `src/app/`. Focused tests cover five-item fit, long-list continuous scrolling, selection visibility, capacity growth, invalid dimensions, resize clamping, narrow rendering, and the 100×22 shell integration.
