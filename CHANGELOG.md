# CHANGELOG.md

## 3.3.5 (2024-04-18)
Fixes / changes:
 - Improve error handling with SN Utils helper tab
 - Added CONTRIBUTING.md

## 3.3.3 (2024-04-18)
Fixes / changes:
 - Misspelling fix (PR #95)

## 3.3.2 (2024-04-15)
Fixes / changes:
 - Support for Inline PowerShell script from Flow Designer Actions (Discussion #492)

## 3.3.1 (2024-03-25)
Fixes / changes:
 - Improvements to the BG script execution.

## 3.3.0 (2024-03-23)
Features:
  - Improved BG Script execution, you can now select to run it in current or global scope.

## 3.2.1 (2024-03-09)
Features:
  - Execute Background Scripts in VS Code (SN Utils discussion #480, credit abhishekg999)

## 3.1.2 (2024-01-30)
Fixes / changes:
  - Backgroundscript matching. (#issue 91)
  - Fix not being able to save _test_urls.txt for Widgets.

## 3.1.0 (2023-10-21)
Fixes / changes:
  - Fix mixing up scope name and label in Link VS COde function in Studio

## 3.1.0 (2023-09-12)
Fixes / changes:
  - Fix for Miiror in sn-scriptsync

## 3.0.9 (2023-08-23)
Fixes / changes:
  - Allow filename change, that updates the _map.json file (Issue #85 PR #90 Blenderpics )
  - Moved initializing of treeview to startServers method, so that it loads more consistent.

## 3.0.8 (2023-08-22)
Fixes / changes:
  - Fix support for saving variables back to instance in the 3.x series

## 3.0.7 (2023-08-22)
Fixes / changes:
  - Fix to allow non scoped files again (will be stored in folder no_scope)

## 3.0.4 (2023-08-15)
Features:
  - Fixe to allow duplicate filename
  - Minor fixes for the 3.x update

## 3.0.0 (2023-08-15)
Features:
  - Check https://youtu.be/cpyasfe93kQ for intro to version 3.0
  - New way of storing files in the structure instamce/scope/table/name.fieldtype.extension
  - Option to pull in all artefacts from current scope
  - Behind the scenes magic to determine all code fields in current instance as well as mapping files to map names to sys_id
Fixes / changes:
  - Add /esc (Employee Center) to test_urls for widget development (Issue: #80)

## 2.7.3 (2023-06-15)
Fixes / changes:
  - Explicit bind websocket to 127.0,0.1 (SN Utils Issue #405)

## 2.7.2 (2023-04-08)
Fixes / changes:
  - Upgrade Node dependencies
  - Remove mkdirp package use in favor of fs.mdir recursive option
  - Remove /dist directory
  - Activated CodeQL repository scanning and applied fixes

## 2.7.0 (2023-04-07)
Features:
  - Save files when instances has a diffrent scope selected, requires SN Utils >= 6.4.0.0

## 2.6.1 and 2.6.2 (2023-02-13)
Fixes / changes:
  - bugfix new intellisense function
  
## 2.6.0 (2023-02-13)
Features:
  - generate types with tablenames and properties to support intellisense for those (Issue #77)
  - added CHANGELOG.md to maintain a changelog 
  - support to manual add content to the .ts file, in additoion to auto generated ones
  - added info.md with instructions how to generate .md file (only for maintenance of sn-scriptsync)

Fixes / changes:
  - updated d.ts files
  - added TemplatePrinter intellisense based on PR #75

