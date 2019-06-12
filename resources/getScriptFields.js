//output of this script is saved in syncfields.json
var tFields = {}
var sf = [
  "css",
  "email_script",
  "html",
  "html_script",
  "html_template",
  "script",
  "script_plain",
  "script_server",
  "translated_html",
  "xml"
]

var sfo = {
  "css" : {"order" : 10,"extension" : "scss" },
  "email_script" : {"order" : 5,"extension" : "js" },
  "html" : {"order" : 6,"extension" : "html" },
  "html_script" : {"order" : 7,"extension" : "html" },
  "html_template" : {"order" : 8,"extension" : "html" },
  "script" : {"order" : 1,"extension" : "js" },
  "script_plain" : {"order" : 2,"extension" : "js" },
  "script_server" : {"order" : 3,"extension" : "js" },
  "translated_html" : {"order" : 4,"extension" : "html" },
  "xml" : {"order" : 9,"extension" : "xml" }
}


var  pa =  new PAUtils();
var t = pa.getTableDecendants('sys_metadata')
for (var i =0; i<t.length;i++){
  var au = new ArrayUtil();
  var g = new GlideRecord(t[i]);
  g.newRecord();
  for (var f in g){
    var ft = g[f].getED().getInternalType();
    var l = g[f].getLabel();
    if (au.contains(sf,ft)){
      if (typeof tFields[t[i]] == 'undefined') {
        tFields[t[i]] = []
      }
      var scriptField = {
        "fieldName" : t[i],
        "label" : l,
        "type" : ft
      }
      tFields[t[i]].push(scriptField);
    }  
  }
}
JSON.stringify(tFields)