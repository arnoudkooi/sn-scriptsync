Generate server.d.ts.txt and client.d.ts.txt 
via the js and instructions in /resources/convertTernToDTS.js
This is recommended after the release of a new version.

Remove GlideRecord part from the client.d.ts

Manual add the content of additional.server.d.ts.txt and additional.client.d.ts.txt 
to respectivly server.d.ts.txt and client.d.ts.txt after generating new base files.

In server.d.ts.txt replace:
tableName: string with tableName: InstanceTableNames
getProperty(key: string with getProperty(key: InstanceProperties


Note: Any requests for additions to the additional.*.d.ts.txt via a Issue, not a PR.

Output should also be copied to variables /js/monaco/libsource.js in SN Utils repo

(Cluncy process I know :( )