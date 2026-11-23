> Prereq: you drive all of this through the Agent API. Read `snu-agent-api`
> first. For screenshots / network / console verification read `snu-browser-debug`.

> Naming: **Lux** is the public name of this framework (Brazil release). On the
> instance it is "AI Experience" (AIUX): the `sys_aix_*` tables and the `/aiux/` URLs.

---

## 0. First: is the app built from source or composed from records?

A Lux app comes to exist in one of two ways, and they need opposite handling.
Decide which one you have **before you create or change anything**.

| | Source-built | Record-composed |
|---|---|---|
| Where the truth lives | A Lux project on disk (`aiux.json`, `pages/`, `widgets/`), deployed with the ServiceNow SDK | The `sys_aix_*` records themselves |
| Pages | One page file per route; the page record has a `page_widget` and no containers | Containers and widget instances under the page |
| Widgets | `sourcemap` is filled, `component_compile_metadata` contains `"asset"`, `component` is minified | `component` holds readable Lit source, `sourcemap` is empty |
| How to change it | Edit the project files, then deploy | Edit the records (sections 1 to 9) |

To tell from the instance, query `sys_aix_widget` for the app's scope with the
fields `id,name,component_compile_metadata`: `"asset"` in the metadata means
built from source. The page widgets of a source-built app are hidden from
`sys_aix_widget` queries; read them through the parent table `sys_ux_widget`
(`sys_class_name=sys_aix_widget`).

### Source-built: never write to its `sys_aix_*` records

They are build output. The next deploy regenerates them, so a record edit is
silently lost.

- Work in the project. It ships its own agent instructions (`AGENTS.md` /
  `CLAUDE.md` and the skills from `@servicenow/agent-pack-aiux`); follow those
  for pages, widgets, loaders and styling. This skill does not replace them.
- Deploy with `sdk_deploy` and wait for its final install result.
- Use the Agent API for what the project cannot do: read records, check the
  rendered page, read logs.
- No project on disk? The source is on the instance. Each built widget keeps
  its original files in `sourcemap` (`sourcesContent`), and the whole project is
  a zip attached to a `sn_glider_source_artifact` record (file name
  `aiux-source <app sys_id>.zip`); fetch it with `download_attachment`.

### Record-composed: the rest of this skill is the recipe

### What the page itself tells you

Every Lux page describes itself, which helps when you verify in the browser:

- `window.__AIUX_MANIFEST__.pages[]`: every route of the experience with its
  element tag (`tagName`); composed pages also carry `pageSysId`.
- `window.__APP_CONFIG__` (source-built: `name`, `basename`, `landing`) or
  `window.__EXPERIENCE_CONFIG__` (composed: `sysId`, `urlSuffix`, `scope`).
- On composed pages each widget element has `data-widget-id`, the sys_id of its
  `sys_aix_widget_instance`.
- `window.__PAGE_TAG__` is not updated on client-side navigation; match the
  address against the routes instead.

For a person at the browser, the SN Utils slash command `/lux` shows the same:
experience, page and widgets, each with a record link.

### The Lux shell

With the Lux experience switched on, the instance root lands on `/aiux/ui/home`
and classic forms and lists open inside the shell at
`/aiux/ui/classic?target=<encoded classic URL>`; `nav_to.do?uri=...` lands
there too. The classic page itself is unchanged (same `g_form`, same list), so
form automation works as before.

---

## 1. Data model (the tables that matter)

| Table | Role | Key fields |
|-------|------|-----------|
| `sys_aix_experience` | Top-level app | `title`, `url_suffix`, `landing_path`, `theme`, `app_shell` |
| `sys_aix_experience_properties` | Per-experience config (incl. menu binding) | `experience`, `name`, `value` |
| `sys_aix_page` | A route within an experience | `sys_name`, `title`, `path_pattern` |
| `sys_aix_experience_page_rel` | Links a page into an experience | `experience`, `page`, `order` |
| `sys_aix_page_route_map` | Path → page routing / aliases | `experience`, `page`, `route_from_path`, `route_to_path`, `active`, `order` |
| `sys_aix_container` | Layout box (tree via `parent_container`) | `page`, `parent_container`, `order`, `classes` |
| `sys_aix_widget_instance` | Places a widget in a container | `container`, `widget`, `order`, `classes`, `properties` (JSON), `name` |
| `sys_aix_widget` | The component definition (extends `sys_ux_widget`) | `name`, `id`, `category`, `component` (Lit), `script` (server), `component_compile_metadata`, `input_schema` |
| `sys_aix_menu` | A navigation menu | `name` |
| `sys_aix_menu_item` | A menu entry | `menu`, `title`, `target_type`, `target_url`, `icon`, `order`, `active`, `category` |
| `sys_aix_app_shell` | App chrome (header/footer/side regions) | `name`, `header`, `start`, `end`, `footer` (each → `sys_aix_widget`), `css` |

**Composition:** `experience → (page_rel) → page → containers (tree by `parent_container`, attached by `container.page`) → widget_instance → widget`.
A page's content is every container whose `page` points at it; the top of the tree is the container(s) with an empty `parent_container`. **There is no `root_container` field** — the page↔container link is `container.page`.

`classes` on containers/instances are **Tailwind utility classes** (e.g. `flex flex-col gap-6 p-6 w-full max-w-3xl`). The runtime ships Tailwind.

---

## 2. Routing & cache (read before you "can't find" your page)

- URL pattern is **`/aiux/<url_suffix>/<path_pattern>`** — e.g. `/aiux/sspoc/home`.
  It is **not** under `/now/`.
- Route params use `:name` segments: `path_pattern = /profile/:userId` →
  `/aiux/sspoc/profile/<sys_id>`. The widget reads the param from the URL.
- After creating/changing experiences, pages, routes, **flush the cache**:
  `rest_request GET /cache.do`. New routes don't resolve until you do.
- **The runtime caches the experience/page config in the browser tab.** A *soft*
  reload often re-uses the stale config (your new container/widget won't appear).
  To force a fresh config fetch, **open a new tab** (or append a throwaway query
  like `?cb=1`) — don't trust an in-place reload after structural changes.
  - ⚠️ Don't leave a cache-buster query on a route that has a `:param` you depend
    on if you're unsure how it parses — verify the param still resolves.

---

## 3. Creating records: use a background script, not REST

> Record-composed experiences only. For a source-built app, change the project
> and deploy (section 0).

Direct REST writes to `sys_aix_*` fail (`E_ACL`, and `create_artifact` →
`E_INTERNAL`) even with the right transaction scope. **Create/modify these
records with `run_background_script`** doing plain GlideRecord inserts, and set
`sys_scope` explicitly to your app.

```javascript
// run_background_script — create an experience + home page + container + instance
var APP   = '<x_scope_app_sys_id>';
var THEME = '<sys_aix_theme_sys_id>';
var WIDGET= '<sys_aix_widget_sys_id>';
var out = {};
function ins(table, vals){
  var gr = new GlideRecord(table); gr.initialize();
  for (var k in vals) gr.setValue(k, vals[k]);
  gr.setValue('sys_scope', APP);
  return gr.insert();
}
out.exp  = ins('sys_aix_experience', {title:'ScriptSync POC', url_suffix:'sspoc', landing_path:'/home', theme:THEME});
out.page = ins('sys_aix_page', {title:'Home', sys_name:'Home', path_pattern:'/home'});
out.rel  = ins('sys_aix_experience_page_rel', {experience:out.exp, page:out.page, order:1});
out.cont = ins('sys_aix_container', {page:out.page, order:0, classes:'flex flex-col gap-6 p-6 w-full max-w-3xl mx-auto'});
out.wi   = ins('sys_aix_widget_instance', {name:'My Widget', container:out.cont, widget:WIDGET, order:0});
out.route= ins('sys_aix_page_route_map', {experience:out.exp, page:out.page, route_from_path:'/home', route_to_path:'/home', active:true, order:10});
gs.print('RESULT_JSON=' + JSON.stringify(out));
```

Print `RESULT_JSON=...` and parse the sys_ids out of the script output for the
next step. Then flush the cache.

> Reuse OOTB widgets the same way — just point `widget_instance.widget` at the
> OOTB `sys_aix_widget` sys_id.

---

## 4. Custom widgets = Lit component + server script + compile metadata

A `sys_aix_widget` is authored as **Lit source** in `component`, with an optional
server-side data script in `script`. The platform auto-compiles on insert/update;
you must supply `component_compile_metadata` describing the imports.

**`component` (client, Lit):**

```javascript
import { html, css } from 'lit';
import { AIUXWidgetElement } from '@servicenow/aiux-components-core';
import { locationService } from '@servicenow/aiux-services';

class MyWidget extends AIUXWidgetElement {
  static properties = {
    table: { type: String },
    _records: { type: Array, state: true },
    _loading: { type: Boolean, state: true }
  };
  constructor() { super(); this.table = 'incident'; this._records = []; this._loading = true; }
  connectedCallback() { super.connectedCallback(); this._load(); }
  _load() {
    // calls the widget's `script` (server) — handles auth/token for you
    this.server.get({ action: 'incidents', table: this.table }).then((d) => {
      this._records = (d && d.records) || []; this._loading = false;
    }).catch(() => { this._loading = false; });
  }
  _open(r) { if (r && r.sys_id) locationService.navigate('/record/' + this.table + '/' + r.sys_id); }
  render() {
    return html`<div class="flex flex-col gap-2 p-6">
      ${this._records.map((r) => html`
        <div class="p-3 rounded-xl" style="cursor:pointer" @click=${() => this._open(r)}>
          ${r.number} — ${r.short_description}
        </div>`)}
    </div>`;
  }
  static styles = css`:host{display:block;}`;
}
```

**`script` (server) — Service-Portal-style `(data, options, input)`:**

```javascript
(function(data, options, input) {
  var t = (input && input.table) ? input.table : 'incident';
  data.table = t;
  try {
    var gr = new GlideRecord(t);
    gr.addEncodedQuery('active=true');
    gr.orderByDesc('sys_updated_on');
    gr.setLimit(5);
    gr.query();
    var rows = [];
    while (gr.next()) rows.push({
      number: gr.getValue('number'),
      short_description: gr.getValue('short_description'),
      priority: gr.getValue('priority'),
      sys_id: gr.getUniqueValue()
    });
    data.records = rows;
  } catch (e) { data.error = e.message; }
})(data, options, input);
```

**`component_compile_metadata` (JSON) — declare every import:**

```json
{
  "imports": {
    "lit": ["html", "css"],
    "@servicenow/aiux-components-core": ["AIUXWidgetElement"],
    "@servicenow/aiux-services": ["locationService"]
  },
  "elementClassName": "MyWidget",
  "importBoundaries": [0, 163]
}
```

- `importBoundaries` = `[0, <byte length of the import block>]` (the chars before
  your class declaration). On a successful save the API echoes back the metadata
  with `hasServerScript: true` — use that to confirm compilation.
- **Data fetching: prefer `this.server.get(...)` → the widget `script`.** Avoid
  client-side `fetch` to the Table API; if you must, it needs the `X-UserToken`
  header (`window.g_ck`) **and** `credentials:'include'`, and you own the ACLs.
- Create the widget with `create_artifact` (`table: sys_aix_widget`,
  `scope: <your app>`, `await: true`) or update with `update_record_batch`.
  Build the payload **in a file** (`JSON.stringify`) and `curl -d @body.json` —
  never hand-escape Lit/JSON on the shell. See `snu-artifacts` › "Large payloads".

---

## 5. Click-through to a record page

1. The OOTB **"Record" page** has `path_pattern = /record/:table/:sys_id` and
   renders the standard AIX record form. (There are also `/ticket/:table/:sys_id`
   and `/task/:table/:sys_id`.)
2. That page lives in the system experience. To use it from **your** experience,
   link it in with a `sys_aix_experience_page_rel` (your `experience` + the
   Record `page` sys_id). Then `/aiux/<suffix>/record/<table>/<sys_id>` resolves.
3. In your widget, navigate on click with
   `locationService.navigate('/record/' + table + '/' + sysId)`
   (import `locationService` from `@servicenow/aiux-services`).

---

## 6. Left-nav menu

**Data model:** a `sys_aix_menu` plus ordered `sys_aix_menu_item` rows. Each item:
`target_type: 'url'`, `target_url: '/home'` (an in-app path), `icon` (an AIX icon
name like `home-outline`, `user-outline`, `tree-outline`), `title`, `order`,
`active`. Bind a menu to an experience via a `sys_aix_experience_properties` row
with `name = 'menu'`, `value = <menu sys_id>`.

```javascript
out.menu     = ins('sys_aix_menu', {name:'My Menu'});
out.mi_home  = ins('sys_aix_menu_item', {menu:out.menu, title:'Home',    target_type:'url', target_url:'/home',        icon:'home-outline', order:0, active:true});
out.mi_prof  = ins('sys_aix_menu_item', {menu:out.menu, title:'Profile', target_type:'url', target_url:'/profile/'+ID, icon:'user-outline', order:1, active:true});
out.bind     = ins('sys_aix_experience_properties', {experience:EXP, name:'menu', value:out.menu});
```

### ⚠️ The menu won't render a nav rail in a custom sub-experience by itself

Binding the `menu` property is correct, but in this build a **custom experience
does not get the platform left-nav chrome** from it, and **`sys_aix_app_shell`
region widgets (`start`/`end`/`header`/`footer`) do not render** custom widgets
either (the OOTB builder shell leaves them empty and only ships CSS). The
root-experience nav is driven by the protected root runtime and isn't
reproducible in a sub-experience.

**What actually works — render the nav as a page widget in a left column:**

1. Build a small **nav widget** (Lit) whose `script` reads the menu items
   (`GlideRecord('sys_aix_menu_item')` filtered to your menu, ordered), and whose
   `render` lists them with `@click=${() => locationService.navigate(it.target_url)}`.
   Highlight the active item via `locationService.path()`.
2. Lay the page out as a **row**: nest containers via `parent_container`.

```javascript
// per page: row → [ nav column | content column ]
var row  = ins('sys_aix_container', {page:PAGE, parent_container:'', order:0, classes:'flex flex-row gap-0 w-full min-h-screen'});
var navc = ins('sys_aix_container', {page:PAGE, parent_container:row, order:0, classes:'shrink-0'});
ins('sys_aix_widget_instance', {name:'Nav', container:navc, widget:NAV_WIDGET, order:0});
// reparent the existing content container under the row, order 1:
var c = new GlideRecord('sys_aix_container');
if (c.get(EXISTING_CONTENT)) { c.setValue('parent_container', row); c.setValue('order', 1); c.update(); }
```

After this, flush the cache and load in a **fresh tab** (§2) — a soft reload will
show the stale single-column layout.

---

## 7. OOTB route-driven widgets (e.g. Employee Profile Card)

Some OOTB widgets are **route-driven**: they read their key (e.g. `userId`) from
the URL `:param`, not from `widget_instance.properties`. The Employee Profile
Card renders only when:
- it sits on a page whose `path_pattern` supplies the param (`/profile/:userId`),
  reached at `/aiux/<suffix>/profile/<sys_id>`; **and**
- the target user actually has the backing data (an `sn_employee_profile` record
  and a valid employee definition). A user without it renders empty — that's a
  **data** problem, not a wiring problem. Test with a known-valid employee first.

Setting `sysUserId` in instance `properties` does **not** drive these widgets.

---

## 8. Verify with CDP (see `snu-browser-debug`)

- `capture_full_page` (no per-tab grant) to screenshot the rendered experience.
- `start_network_capture` (`includeBodies:true`) filtered to `/api/now/aix/widget`
  to confirm a widget's `this.server.get` fired (`POST 201
  /api/now/aix/widget/<widget-id>`) and inspect the returned `data`.
- `start_console_capture` to catch Lit/compile/runtime errors. If a region or
  nested container renders empty, first re-capture in a **fresh tab** to rule out
  the config cache before debugging the records.
- The experience config endpoint (`/api/now/aix/config/<suffix>`) only answers
  `multipart/mixed`, so read it via a network capture, not `rest_request`.

---

## 9. Gotchas checklist

- [ ] Source-built app (section 0) → change the project and deploy; never edit its `sys_aix_*` records.
- [ ] Creating `sys_aix_*` via REST → use `run_background_script` instead.
- [ ] Page not found → URL is `/aiux/<suffix>/...`, and you flushed `/cache.do`.
- [ ] Edits not showing → load in a **fresh tab** (client config cache).
- [ ] Widget blank → check compile metadata `importBoundaries`/`imports`, and
      confirm `this.server.get` fired via a network capture.
- [ ] Menu has no nav rail → render a nav widget in a left column; app-shell
      regions don't render custom widgets here.
- [ ] OOTB profile/record widget empty → route `:param` + backing data, not
      instance `properties`.
