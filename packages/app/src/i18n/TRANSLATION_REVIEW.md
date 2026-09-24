# Koda Translation Review

## Scope

Filled missing application and shared UI dictionary entries for 60 locales.
English remains the semantic source. Simplified Chinese and desktop renderer
dictionaries already had the required keys. Product names, command examples,
URLs, interpolation placeholders, and API identifiers are preserved.

## Reference Sources

Terminology research used these maintained localization resources:

- Firefox: https://github.com/mozilla-l10n/firefox-l10n
- VS Code: https://github.com/microsoft/vscode-loc
- KDE localized applications, including Kate and Lithuanian translations
- Unicode CLDR: https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html
- GNOME GLib Arabic and Greek translations
- GNOME GTK Dzongkha: https://github.com/GNOME/gtk/blob/main/po/dz.po
- Malay DBP and the Latvian terminology portal

Coverage of two independent corpora and language-authority references is not
complete for every locale. These references support terminology research, not
native-speaker approval of every sentence.

## Remaining Linguistic Review

Review AI-specific terms such as skill, prompt, upstream, and relay for natural
phrasing and consistency. Prioritize Faroese, Khmer, Lao, Burmese, Dzongkha,
Amharic, Dhivehi, Turkmen, and Shahmukhi Punjabi. Arabic count phrasing also
needs native-speaker review. Existing values identical to English have not all
been classified as intentional borrowings versus untranslated text.

Dictionary parity verifies keys, placeholders, and required plural categories.
It does not establish translation quality or validate text clipping, RTL layout,
or every screen in a packaged desktop application.
