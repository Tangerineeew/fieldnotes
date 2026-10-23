# Fieldnotes

**English** | [简体中文](README.zh-CN.md)

A private Markdown library for travel knowledge in [TREK](https://github.com/mauriceboe/TREK). Write a tip once, keep it in folders, and bring it into any trip as a live reference that follows your edits or as a frozen snapshot that the trip keeps forever.

Fieldnotes adds a **Fieldnotes** page to TREK's navigation. Its companion plugin, [Trip Fieldnotes](https://github.com/Tangerineeew/fieldnotes-trip), adds a tab inside each trip where everyone on the trip can read what has been shared with it.

## What it does

- **A library that stays yours.** Notes are private by default. Organise them in nested folders with emoji icons, sort by name or date, and search titles, text and property values.
- **A live Markdown editor.** Headings, lists, tables, quotes and links render as you type; the syntax only appears around the cursor. Type `/` for blocks, paste or drop images, and link other notes with `[[Note title]]` or `[[Folder/Note title]]`.
- **Typed properties.** Give a note text, number, date, select, multi-select, checkbox, URL, checklist or last-edited fields. Select options become coloured labels, and checklists show their progress.
- **Sharing with intent.** Invite people you travel with as editors or viewers of a single note or of a whole folder. Only the owner decides who can see a note, makes it public to every signed-in user, or moves it between folders.
- **Real-time co-editing.** Editors who open the same note edit one shared document, see each other's cursors, and never overwrite each other's changes.
- **Bring notes into trips.** A live reference shows the current version to every member of the trip. A snapshot freezes the note, including copies of its images, and stays with the trip even if the original is deleted. Any excerpt of up to 500 characters can also be copied into a day of the trip plan.
- **Images that travel with the note.** Pasted images are compressed in the browser and stored inside the plugin, so they keep working without an external host. Images linked from websites an administrator allows work too.
- **Fourteen languages.** The interface and its error messages follow TREK's language setting: English, Simplified and Traditional Chinese, German, Spanish, French, Hungarian, Dutch, Brazilian Portuguese, Czech, Polish, Russian, Italian and Arabic, including right-to-left layout.

## Screenshots

![Fieldnotes library with a note open](./docs/screenshot.png)

## Permissions

Fieldnotes keeps its notes, folders, sharing settings and images in its own database and only asks TREK for what the features above need. Every request runs as the signed-in user, so TREK's own trip roles still apply.

| Permission | Why Fieldnotes needs it |
|---|---|
| `db:own` | Stores notes, folders, collaborators, trip links, snapshots and uploaded images in the plugin's own database. |
| `db:read:trips` | Lists your trips and their days for "Bring into a trip", and checks trip membership before showing shared notes. People you can invite are the members of trips you share. |
| `db:read:files` | Resolves images that reference a file attached to a trip, written as `fieldnotes://trip-file/<trip>/<file>`. |
| `db:read:files:content` | Reads the bytes of those trip-file images to display them and to copy them into snapshots. |
| `db:meta` | Confirms that you may edit a trip before you link, unlink or organise its notes. Fieldnotes asks TREK to delete a throwaway metadata key, which TREK only allows trip editors to do; it never stores trip metadata. |
| `db:write:daynotes` | Copies an excerpt you choose into a day of the trip plan. TREK still requires day-edit rights. |
| `db:read:users` | Shows the names of people editing a note with you. |
| `hook:user-data` | Exports or erases a user's notes, folders, images and trip links when TREK exports or deletes that account. |
| `http:outbound` | Loads images that a note embeds by `https://` link, on the server so readers never contact the site directly. |

The plugin declares `operatorEgress`, so it cannot reach any website until an administrator allows that host. Private and local network addresses are always refused, and redirects are checked again before they are followed.

## Setup

1. In TREK, open **Admin → Plugins**, install **Fieldnotes**, and then install [Trip Fieldnotes](https://github.com/Tangerineeew/fieldnotes-trip).
2. Enable **Fieldnotes** first and **Trip Fieldnotes** second; the trip tab depends on the library. Uploaded plugins start disabled.
3. Optional: to show images that notes link from other websites, open **Admin → Plugins → ⋯ → Allowed hosts** on Fieldnotes and add those hosts, for example `*.example.com`. Copying the image itself and pasting it into the note works without any configuration.
4. Open **Fieldnotes** from the navigation bar and write your first note.

Uninstalling Fieldnotes deletes every note, folder, image and sharing setting it stores. Back up TREK first if you might want them back. Updating to a newer release keeps all data.

## Development

The repository root is the built plugin, exactly what TREK installs. The source lives in [`source/`](./source): the React client in `client/`, the server in `server/`, limits shared by both in `shared/`, and tests in `tests/`.

```bash
cd source
npm ci
npm run check   # TypeScript
npm test        # server, client and translation tests
npm run pack    # builds dist/fieldnotes.zip and dist/fieldnotes-trip.zip
```

Every visible message is translated through `client/i18n.ts`; the translation test fails when a message is missing in any language.

## License

[MIT](./LICENSE)
