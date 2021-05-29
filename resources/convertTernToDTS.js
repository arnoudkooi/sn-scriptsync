/**
 * convert tern file to a .d.ts typescript stub
 * Get (server) json with this bg script set it to variable x in browser console and run the script
gs.log( new GlideScriptEditorManager().getApis('sys_script', 'script',null)); //server.d.ts
gs.log( new GlideScriptEditorManager().getApis('sys_script_client', 'script',null)); //client.d.ts
 */

function itterateClass(clsName, cls, classOrVariable) {
    var outp = '';
    var extendsClass = '';
    var xtds = '';
    var protoType = cls
    try {
        if (classOrVariable == 'class' || classOrVariable == 'namespace') {
            extendsClass = (cls["!type"].includes('('));
            xtds = extendsClass ? '' : ' extends ' + cls["!type"];
            var protoType = cls['prototype'];
        }
        else {
            clsName = classOrVariable
        }

        outp += 'class ' + clsName + xtds + '{\n';
        if (classOrVariable == 'class' || classOrVariable == 'namespace') {
            outp += (extendsClass) ? '\nconstructor' + 
            cls["!type"].substring(2, 2000).
            replace('->', ':').
            replace(/\+/g, '') + '{};\n\n' : '';
        }
        for (var currentFunction in protoType) {
            var functionObj = protoType[currentFunction];
            if (typeof functionObj == 'object') {
                if (!currentFunction.includes('<')) {
                    outp += "/** " + functionObj["!doc"] + " */\n";
                    outp += currentFunction
                    if (functionObj.hasOwnProperty('!type')) {
                        if (functionObj["!type"].includes('fn')) {
                            outp += functionObj["!type"].
                                substring(2, 2000).
                                replace('->', ':').
                                replace(': fn()', '').
                                replace(/\+/g, '') + ' {};';
                        }
                        else {
                            outp += ' : ' + functionObj["!type"].replace(/\+/g, '') + ';'
                        }
                    }
                    outp += '\n\n';
                }
            }
        }
        outp += '}\n\n'

        if (classOrVariable != 'class' && classOrVariable != 'namespace') {
            outp += clsName = 'var ' + api + ' = new ' + classOrVariable + '();\n';
        }
    }
    catch (e) {
    }
    return outp
}


var outp = ''
for (api in x) {
    //if (api == 'getMessage') {
        try {
            var currObj = x[api];
            outp += "/** " + currObj["!doc"] + " */\n"
            if (typeof currObj["!type"] != 'undefined') {
                outp += itterateClass(api, currObj, 'class');
            }
            else if (currObj.hasOwnProperty("")) {
                outp += 'namespace ' + api + ' {\n';

                for (c in currObj) {
                    if (typeof currObj[c] == 'object' && c != '') {

                        outp += itterateClass(c, currObj[c], 'namespace');
                    }
                }
                outp += '}\n\n';
            }
            else {
                if (api == 'gs') {
                    outp += itterateClass(api, currObj, 'GlideSystem');
                }
                else {
                    outp += itterateClass(api, currObj, api + '_proto');
                }
            }

        } catch (e) {
            outp += '\n//ERROR ' + e + '\n'
        }
    //}
}

console.log(outp);