# CHANGELOG.md

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

