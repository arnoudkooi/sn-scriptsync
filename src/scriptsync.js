let t;
let realTimeUpdating = false;
let msg;
let msgCnt = 0;
let msgShown = false;
let scriptTabCreated = false;
let ws;
let thistabid
let scriptsyncinstances;

// Screenshot state - track last used tab to avoid repeated permission prompts
let lastScreenshotTabId = null;
let pendingScreenshotRequest = null; // Store pending request while waiting for user action

function sanitizeHtml(html) {
    const s = String(html)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    return s
        .replace(/&lt;(\/?)(b|i|em|strong|code)&gt;/gi, '<$1$2>')
        .replace(/&lt;br\s*\/?&gt;/gi, '<br />')
        .replace(/&lt;span class=&quot;([a-zA-Z0-9_ -]+)&quot;&gt;/gi, '<span class="$1">')
        .replace(/&lt;\/span&gt;/gi, '</span>');
}

// Simple Table Component replacement for DataTable
class SimpleTable {
    constructor(tableId) {
        this.tbody = document.querySelector(`#${tableId} tbody`);
    }

    addRow(data) {
        // data expected: [Date Object, Origin, Message]
        const row = document.createElement('tr');
        
        // Time Cell
        const timeCell = document.createElement('td');
        const timeStr = data[0].toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        timeCell.textContent = timeStr;
        row.appendChild(timeCell);

        // Origin Cell
        const originCell = document.createElement('td');
        originCell.textContent = data[1];
        row.appendChild(originCell);

        // Message Cell
        const msgCell = document.createElement('td');
        msgCell.innerHTML = sanitizeHtml(String(data[2]));
        row.appendChild(msgCell);

        // Prepend to show newest first (like desc sort)
        if (this.tbody.firstChild) {
            this.tbody.insertBefore(row, this.tbody.firstChild);
        } else {
            this.tbody.appendChild(row);
        }
    }
}

chrome.tabs.getCurrent(tab => { thistabid = tab.id });

//this replaces the  webserver port 1977 communication to proxy ecverything through websocket/helpertab
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.event == "scriptsyncpostdata") {

        let instanceurl = message?.command?.instance?.url;
        if (instanceurl && scriptsyncinstances?.allowed?.includes(instanceurl))
            ws.send(JSON.stringify(message.command));
        else if (instanceurl && scriptsyncinstances?.blocked?.includes(instanceurl)) {
            t.addRow([
                new Date(), 'ServiceNow', 'Received from blocked source: <b>' + instanceurl + '</b><br />Message ignored'

            ]);
            flashFavicon('images/iconred48.png', 3);
        }
        else if (instanceurl) {
            msg = message;
            document.querySelector('#instanceurl').innerText = instanceurl
            document.querySelector('#instanceapprovediv').classList.remove("hidden");
            flashFavicon('images/iconred48.png', 3);
            let audio = new Audio('/images/alert.mp3');
            audio.play();
            document.title = "[" + (++eventCount) + "] SN-SCRIPTSYNC ATTENTION";
        }
        else {
            t.addRow([
                new Date(), 'ServiceNow', 'Unkown message<br />Message ignored, check browser console'
            ]);
            flashFavicon('images/iconred48.png', 3);
            console.log(message);
        }

    }
});




document.addEventListener('DOMContentLoaded', function () {

    // Tab switching logic
    const tabs = document.querySelectorAll('[data-tab-target]');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = document.querySelector(tab.dataset.tabTarget);
            
            // Toggle active class on tabs
            document.querySelectorAll('.nav-link').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            // Toggle visibility of content
            document.querySelectorAll('.tab-pane').forEach(content => {
                content.classList.add('hidden');
                //content.classList.remove('active'); // Helper class if needed
            });
            target.classList.remove('hidden');
            target.classList.add('active');
        });
    });

    document.querySelector('#instanceallow').addEventListener('click', (e) => {
        let instanceurl = msg?.command?.instance?.url;
        scriptsyncinstances.allowed.push(instanceurl);
        setGlobalSetting('scriptsyncinstances', scriptsyncinstances);
        document.querySelector('#instanceapprovediv').classList.add("hidden");
        t.addRow([
            new Date(), 'Helper tab', 'Allowed source: <b>' + instanceurl + '</b><br />Message send to VS Code sn-scriptsync'
        ]);
        ws.send(JSON.stringify(msg.command));
        increaseTitlecounter();
        flashFavicon('images/icongreen48.png', 1);
        msg = null;
        setInstanceLists();
    })

    document.querySelector('#instanceblock').addEventListener('click', (e) => {
        let instanceurl = msg?.command?.instance?.url;
        scriptsyncinstances.blocked.push(instanceurl);
        setGlobalSetting('scriptsyncinstances', scriptsyncinstances);
        document.querySelector('#instanceapprovediv').classList.add("hidden");

        t.addRow([
            new Date(), 'Helper tab', 'Blocked source: <b>' + instanceurl + '</b><br />Message ignored'

        ]);
        increaseTitlecounter();
        msg = null;
        setInstanceLists();

    })

    getGlobalSetting('scriptsyncinstances', c => {
        scriptsyncinstances = c || { allowed: [], blocked: [] }
        setInstanceLists();
    });

    t = new SimpleTable('synclog');

    // $('#addRow').on('click', function () {
    //     t.row.add([
    //         new Date(), 'click', '', '', '', ''
    //     ]).draw(false);
    // });


    function connect() {

        ws = new WebSocket("ws://127.0.0.1:1978");


        ws.onerror = function (evt) {

            if (msgShown) {
                return;
            }
            msgShown = true;

            t.addRow([
                new Date(), 'WebSocket', '<b>Could not connect to WebSocket.</b><br />Check if VS Code is running and wait for connection or reload the page.<br />' +
                '<a target="_blank" href="https://marketplace.visualstudio.com/items?itemName=arnoudkooicom.sn-scriptsync">Get sn-scriptsync from Visual Code Marketplace</a>'
            ]);
            increaseTitlecounter();
            flashFavicon('images/iconred48.png', 3);
            //setTimeout(function () { location.reload(true); }, 30000);
        };

        ws.onclose = function (evt) {
            if (msgCnt > 0) {
                t.addRow([
                    new Date(), 'WebSocket', '<b>Connection to WebSocket lost, check if sn-scriptsync runs and wait for connection or reload page.</b>'
                ]);
                increaseTitlecounter();
                flashFavicon('images/iconred48.png', 3);
                msgCnt = 0;
            }

            setTimeout(function () {
                connect();
            }, 1000);
        };

        ws.onmessage = function (evt) {
            msgCnt++;
            let wsObj = JSON.parse(evt.data);
            let instanceurl = wsObj?.instance?.url;
            if (instanceurl && scriptsyncinstances?.allowed?.includes(instanceurl)) {
                // cleared!
            }
            else if (instanceurl && scriptsyncinstances?.blocked?.includes(instanceurl)) {
                t.addRow([
                    new Date(), 'VS Code', 'Received from blocked source: <b>' + instanceurl + '</b><br />Message ignored'

                ]);
                flashFavicon('images/iconred48.png', 3);
                return false;
            }
            else if (instanceurl) {
                t.addRow([
                    new Date(), 'VS Code', 'Unknown source: <b>' + instanceurl + '</b><br />' +
                    'The last SN Utils update requires approval per instance, please run /token from the instance to approve or block.<br />' +
                    '<b>Message not processed</b>'

                ]);
                flashFavicon('images/iconred48.png', 3);
                let audio = new Audio('/images/alert.mp3');
                audio.play();
                document.title = "[" + (++eventCount) + "] SN-SCRIPTSYNC ATTENTION";
                return false;
            }

            if (wsObj.hasOwnProperty('liveupdate')) {
                updateRealtimeBrowser(wsObj);
            }
            else if (wsObj.hasOwnProperty('mirrorbgscript')) {
                mirrorBgScript(wsObj);
            }
            else if (wsObj.hasOwnProperty('refreshedtoken')) {
                refreshedToken(wsObj);
                flashFavicon('images/icongreen48.png', 4);
                increaseTitlecounter();
            }
            else {
                realTimeUpdating = false;
                if ('contentLength' in wsObj) {
                    t.addRow([
                        new Date(), 'ServiceNow', 'Opened in VS Code: <b>' + wsObj.name + '</b><br /><span class="code">Instance: ' +
                        wsObj.instance.name + ' | Field: ' + wsObj.table + '.' + wsObj.field +
                        ' | Characters: ' + wsObj.contentLength + '</code>'
                    ]);
                    flashFavicon('images/icongreen48.png', 4);
                    increaseTitlecounter();
                } else if (wsObj.action == 'requestRecord') {
                    requestRecord(wsObj);
                } else if (wsObj.action == 'requestRecords') {
                    requestRecords(wsObj);
                } else if (wsObj.action == 'requestAppMeta') {
                    requestAppMeta(wsObj);
                } else if (wsObj.action == 'bannerMessage') {
                    setBannerMessage(wsObj);
                } else if (wsObj.action == 'updateVar') {
                    updateVar(wsObj);
                } else if (wsObj.action == 'executeBackgroundScript') {
                    snuStartBackgroundScript(wsObj.content, wsObj.instance, wsObj.action);
                }  else if (wsObj.action == 'createRecord') {
                    createRecord(wsObj);
                } else if (wsObj.action == 'requestTableStructure') {
                    requestTableStructure(wsObj);
                } else if (wsObj.action == 'checkNameExists') {
                    checkNameExists(wsObj);
                } else if (wsObj.action == 'agentGetParentOptions') {
                    agentGetParentOptions(wsObj);
                } else if (wsObj.action == 'agentQueryRecords') {
                    agentQueryRecords(wsObj);
                } else if (wsObj.action == 'refreshPreview') {
                    refreshPreview(wsObj);
                } else if (wsObj.action == 'takeScreenshot') {
                    takeScreenshot(wsObj);
                } else if (wsObj.action == 'uploadAttachment') {
                    uploadAttachment(wsObj);
                } else if (wsObj.action == 'activateTab') {
                    activateTab(wsObj);
                } else if (wsObj.action == 'runSlashCommand') {
                    runSlashCommand(wsObj);
                } else if (wsObj.action == 'switchContext') {
                    switchContext(wsObj);
                } else if (wsObj.action == 'agentRestApi') {
                    agentRestApi(wsObj);
                } else if (wsObj.action == 'agentGetContext') {
                    agentGetContext(wsObj);
                } else if ('instance' in wsObj) {
                    if (wsObj.tableName == 'flow_action_scripts') {
                        updateActionScript(wsObj);
                    }
                    else
                        updateRecord(wsObj, true);
                } else {
                    increaseTitlecounter();
                    if (evt.data.includes('error') || evt.data.includes('errno')) {

                        var data = JSON.parse(evt.data);

                        if (data?.errno == -30 || data?.errno == -4048) { //-30 mac -4048 windows
                            t.addRow([
                                new Date(), 'VS Code', `Error, could not create sub folder. Please check the following:<br />
                                <ol>
                                    <li>Do you have full write access to the current folder in VS Code.</li>
                                    <li>If you have opened a workspace with multiple (virtual)folders, close the workspace and open the folder direct in VS Code.</li>
                                    <li>Restart sn-scriptsync in VS Code by clicking the sn-scriptsync in the bottom bar in VS Code twice.</li>
                                </ol>
                                It is recommended to create a folder named scriptsync in your documents folder and open that in VS Code. <br />
                                Follow instructions in <a href='https://youtu.be/ZDDminMjGTA?t=40' target='_blank'>this video</a>.`
                            ]);
                        }
                        else {
                            t.addRow([
                                new Date(), '', `<pre> ${JSON.stringify(data, 4, 4)}</pre>`
                            ]);
                            t.addRow([
                                new Date(), 'VS Code', "Error, please check browser console or message below to review error details. Follow instructions in <a href='https://youtu.be/ZDDminMjGTA?t=40' target='_blank'>this video</a>"
                            ]);
                        }

                        console.dir(data);
                        flashFavicon('images/iconred48.png', 3);
                        ws.send(wsObj);
                    }
                    else {
                        t.addRow([
                            new Date(), 'WebSocket', JSON.parse(evt.data)
                        ]);
                        flashFavicon('/images/icon32.png', 1);
                    }
                }
            }
        };

        window.onbeforeunload = function () {
            ws.onclose = function () { };
            ws.close();
            return "Are you sure you want to navigate away?";
        };
    }
    connect();

});

// I add a safeFetch wrapper that only allows approved instance URLs
function isApprovedInstanceUrl(rawUrl) {
  return scriptsyncinstances?.allowed?.includes(rawUrl);
}

function getApprovedOrigin(rawUrl) {
  const allowed = scriptsyncinstances?.allowed || [];
  for (const entry of allowed) {
    try {
      const approvedUrl = new URL(entry);
      if (approvedUrl.origin === new URL(rawUrl).origin) return approvedUrl.origin;
    } catch (_) { /* skip malformed entries */ }
  }
  return null;
}

async function safeFetch(path, rawUrl, init) {
  const origin = getApprovedOrigin(rawUrl);
  if (!origin) {
    throw new Error(`Fetch to unapproved instance URL blocked: ${rawUrl}`);
  }
  let pathParsed;
  try {
    pathParsed = new URL(path, 'https://placeholder.invalid');
  } catch (e) {
    throw new Error(`Invalid path: ${e.message}`);
  }
  const safeUrl = origin + pathParsed.pathname + pathParsed.search;
  return fetch(safeUrl, init);
}

async function requestRecord(requestJson) {
    t.addRow([new Date(), requestJson.appName || 'VS Code', `Requesting record: <b>${requestJson.tableName}/${requestJson.sys_id}</b>`]);
    increaseTitlecounter();
    
    try {
        const response = await safeFetch(`/api/now/table/${requestJson.tableName}/${requestJson.sys_id}`, requestJson.instance.url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-UserToken': requestJson.instance.g_ck
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const resp = await response.json();

        if (resp.hasOwnProperty('result')) {
            if (requestJson.hasOwnProperty('actionGoal') && requestJson.actionGoal !== 'updateCheck') {
                t.addRow([new Date(), 'VS Code', `Received from ServiceNow: <b>${requestJson.name}</b><br /><span class="code">Instance: ${requestJson.instance.name} | Table: ${requestJson.tableName}</span>`
                ]);
            }
            increaseTitlecounter();
            requestJson.type = "requestRecord";
            requestJson.result = resp.result;
            ws.send(JSON.stringify(requestJson));
        } else {
            t.addRow([new Date(), 'VS Code', resp
            ]);
            increaseTitlecounter();
            ws.send(JSON.stringify(resp));
        }
    } catch (error) {
        console.error('requestRecord error:', error);
        t.addRow([new Date(), 'VS Code', `An error occurred: ${error}`]);
        increaseTitlecounter();
        ws.send(JSON.stringify({ error: error.message }));
    }
}


function setBannerMessage(wsObj) {
    let bnr = document.querySelector('#bannermessage');
    bnr.innerHTML = DOMPurify.sanitize(wsObj.message);
    bnr.className = wsObj.class;
}



async function requestToken(scriptObj) {
    try {
        t.addRow([
            new Date(), 'WebSocket', 'Trying to acquire new token from instance'
        ]);
        const response = await safeFetch(`/sn_devstudio_/v1/get_publish_info.do`, scriptObj.instance.url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'Authorization': 'BasicCustom'
            }
        });

        if (!response.ok) {
            t.addRow([new Date(), 'WebSocket', `Error: ${JSON.stringify(resp)}`
            ]);
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const resp = await response.json();

        if (resp.hasOwnProperty('ck')) {
            scriptObj.instance.g_ck = resp.ck;
            const data = {
                "action": "writeInstanceSettings",
                "instance": scriptObj.instance
            };
            increaseTitlecounter();
            ws.send(JSON.stringify(data));

            t.addRow([new Date(), 'WebSocket', `New token acquired from: ${scriptObj.instance.name}`
            ]);

            updateRecord(scriptObj, false);
        } else {
            t.addRow([new Date(), 'WebSocket', `Error: ${JSON.stringify(resp)}`
            ]);
        }
    } catch (error) {
        console.error('requestToken error:', error);
        t.addRow([new Date(), 'WebSocket', `An error occurred: ${error}`
        ]);
    }
}


async function requestRecords(requestJson) {
    t.addRow([new Date(), requestJson.appName || 'VS Code', `Querying records: <b>${requestJson.tableName}</b>`]);
    increaseTitlecounter();
    
    try {
        const response = await safeFetch(`/api/now/table/${requestJson.tableName}?${requestJson.queryString}`, requestJson.instance.url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-UserToken': requestJson.instance.g_ck
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const resp = await response.json();
        if (resp.hasOwnProperty('result')) {
            t.addRow([
                new Date(), 'VS Code', `Received from ServiceNow: <b>${resp.result.length} records</b><br /><span class="code">Instance: ${requestJson.instance.name} | Table: ${requestJson.tableName}</span>`
            ]);

            increaseTitlecounter();
            requestJson.type = "requestRecords";
            requestJson.results = resp.result;
            ws.send(JSON.stringify(requestJson));
        } else {
            t.addRow([new Date(), 'VS Code', JSON.stringify(resp)
            ]);
            increaseTitlecounter();
            ws.send(JSON.stringify(resp));
        }
    } catch (error) {
        console.error('requestRecords error:', error);
        t.addRow([new Date(), 'VS Code', `An error occurred: ${error}`
        ]);
        increaseTitlecounter();
    }
}


async function requestAppMeta(requestJson) {
    try {
        const response = await safeFetch(`/_sn/sn_devstudio_/v1/ds?sysparm_transaction_scope=${requestJson.appId}`, requestJson.instance.url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-UserToken': requestJson.instance.g_ck
            }
        });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const resp = await response.json();
        if (resp.hasOwnProperty('artifacts')) {
            t.addRow([new Date(), 'VS Code', `Received Scope artifacts from app: <b>${requestJson.appName}</b><br /><span class="code">Instance: ${requestJson.instance.name} | scope: ${requestJson.appScope}</span>`
            ]);
            increaseTitlecounter();
            requestJson.type = "requestRecord";
            requestJson.result = resp;
            ws.send(JSON.stringify(requestJson));
        } else {
            t.addRow([
                new Date(), 'VS Code', JSON.stringify(resp)
            ]);
            increaseTitlecounter();
            ws.send(JSON.stringify(resp));
        }
    } catch (error) {
        console.error('requestAppMeta error:', error);
        t.addRow([new Date(), 'VS Code', `An error occurred: ${error}`
        ]);
        increaseTitlecounter();
    }
}

function updateRealtimeBrowser(scriptObj) {
    if (!realTimeUpdating) {
        t.addRow([
            new Date(), 'VS Code', 'Realtime updating widget CSS'
        ]);
        realTimeUpdating = true;
    }

    chrome.tabs.query({
        currentWindow: true,
        active: true
    },
        function (tabs) {
            if (tabs[0].id == thistabid) return;
            chrome.tabs.sendMessage(tabs[0].id, {
                method: "runFunction",
                myVars: "document.getElementById('v" + scriptObj.sys_id + "-s').innerHTML = `" + DOMPurify.sanitize(scriptObj.css) + "`"
            });
        }
    );

}

function mirrorBgScript(scriptObj) {
    if (!realTimeUpdating) {
        t.addRow([
            new Date(), 'VS Code', 'Realtime updating Background Script'
        ]);
        realTimeUpdating = true;
    }


    chrome.tabs.query({ //in iframe
        url: scriptObj.instance.url + "/*sys.scripts.do*"
    }, function (arrayOfTabs) {


        if (arrayOfTabs.length) {
            scriptTabCreated = false;
            var prefix = "document.";
            if (arrayOfTabs[0].url.includes("nav_to.do?uri=%2Fsys.scripts.do")) prefix = "gsft_main.document.";
            else if (arrayOfTabs[0].url.includes("now/nav/ui/classic/params/target/sys.scripts.do")) prefix = "document.querySelector('[macroponent-namespace]').shadowRoot.querySelector('#gsft_main').contentDocument.";

            console.log(arrayOfTabs);
            chrome.tabs.sendMessage(arrayOfTabs[0].id, {
                method: "setBackgroundScript",
                myVars: scriptObj
            });
        }
        else if (!scriptTabCreated) {
            var createObj = {
                'url': scriptObj.instance.url + "/sys.scripts.do",
                'active': true
            }
            chrome.tabs.create(createObj,
                function (tab) {
                    console.log(tab);
                    chrome.tabs.sendMessage(tab.id, {
                        method: "setBackgroundScript",
                        myVars: scriptObj
                    });
                }
            );

            t.addRow([
                new Date(), 'VS Code', 'Opening new Background Script tab'
            ]);

            scriptTabCreated = true;
        }

    });

}

function refreshedToken(instanceObj) {
    t.addRow([
        new Date(), 'VS Code', instanceObj.response
    ]);
}

function refreshToken(instanceObj) { //todo check mv3 compatability

    t.addRow([
        new Date(), 'WebSocket', "Invalid token, trying to get new g_ck token from instance: " + instanceObj.name
    ]);


    chrome.tabs.query({
        url: instanceObj.url + "/*"
    }, function (arrayOfTabs) {
        if (arrayOfTabs.length) {
            chrome.tabs.executeScript(arrayOfTabs[0].id, { "code": "document.getElementById('sn_gck').value" },
                function (g_ck) {
                    console.log(g_ck)
                });
        }
        else {
            t.addRow([
                new Date(), 'WebSocket', "Request g_ck failed, please open a new session " + instanceObj.name
            ]);
        }
    });
}



async function updateRecord(scriptObj, canRefreshToken) {
    try {
        const scope = scriptObj?.scope ? `&sysparm_transaction_scope=${scriptObj.scope}` : '';
        
        // Build payload - support both single field and multi-field updates
        let payload;
        let fieldInfo;
        let charCount;
        
        if (scriptObj.fields && typeof scriptObj.fields === 'object') {
            // Multi-field update
            payload = scriptObj.fields;
            fieldInfo = Object.keys(scriptObj.fields).join(', ');
            charCount = Object.values(scriptObj.fields).reduce((sum, val) => sum + String(val).length, 0);
        } else {
            // Single field update (backwards compatible)
            payload = { [scriptObj.fieldName]: scriptObj.content };
            fieldInfo = scriptObj.fieldName;
            charCount = scriptObj.content.length;
        }
        
        const response = await safeFetch(`/api/now/table/${scriptObj.tableName}/${scriptObj.sys_id}?sysparm_fields=sys_id${scope}`, scriptObj.instance.url, {
            method: 'PUT',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-UserToken': scriptObj.instance.g_ck
            },
            body: JSON.stringify(payload)
        });

        const resp = await response.json();

        if (!response.ok) {
            if (resp){
                t.addRow([new Date(), 'VS Code', `An error occurred: ${resp.error.detail}`]);
                increaseTitlecounter();
                ws.send(JSON.stringify(resp));
                throw new Error(`catched`);
            }   
            else
                throw new Error(`HTTP error! Status: ${response.status}, StatusText: ${response.statusText}`);
           
        }

        

        if (resp.hasOwnProperty('result')) {
            t.addRow([
                new Date(), 'VS Code', 'Saved to ServiceNow: <b>' + scriptObj.name + '</b><br /><span class="code">Instance: ' +
                scriptObj.instance.name +
                ' | Field(s): ' + scriptObj.tableName + '.' + fieldInfo +
                ' | Save source: ' + (scriptObj.saveSource || "unknown") +
                ' | Characters: ' + charCount + '</span>'

            ]);
            flashFavicon('images/icongreen48.png', 4);
            increaseTitlecounter();

            if (scriptObj.hasOwnProperty('testUrls')) {
                for (var i = 0; i < scriptObj.testUrls.length; i++) {
                    chrome.tabs.query({
                        url: scriptObj.testUrls[i]
                    }, function (arrayOfTabs) {
                        if (arrayOfTabs.length)
                            chrome.tabs.reload(arrayOfTabs[0].id);
                    });
                }
            }
            if (document.querySelector('#reloadactivetab').checked) {
                chrome.tabs.query({
                    active: true,
                    currentWindow: true
                }, function (arrayOfTabs) {
                    console.log(arrayOfTabs[0]);
                    console.log(scriptObj);

                    if (arrayOfTabs.length && arrayOfTabs[0].hasOwnProperty("url") && arrayOfTabs[0].url.startsWith(scriptObj.instance.url))
                        chrome.tabs.reload(arrayOfTabs[0].id);
                });
            }
        }
        else {
            resp = JSON.parse(this.response);
            if (resp.hasOwnProperty('error')) {
                if (resp.error.hasOwnProperty('message')) {
                    // if (resp.error.message == "User Not Authenticated"){
                    //     if (canRefreshToken){
                    //         requestToken(scriptObj);
                    //         return;
                    //     }
                    // }
                }
            }
            t.addRow([
                new Date(), 'VS Code', this.response
            ]);
            flashFavicon('images/iconred48.png', 3);
            increaseTitlecounter();
            ws.send(this.response);
        }
    } catch (error) {
       if (!error.toString().includes('catched')){
            console.error('updateRecord error:', error);
            t.addRow([new Date(), 'VS Code', `An error occurred: ${error.message}`]);
            increaseTitlecounter();
            ws.send(JSON.stringify({ error: error.toString() }));
        }
    }
}



async function createRecord(wsObj) {
    t.addRow([new Date(), wsObj.appName || 'VS Code', `Creating record: <b>${wsObj.tableName}</b>`]);
    increaseTitlecounter();
    
    try {
        const payload = wsObj.payload;
        const tableName = wsObj.tableName; // Passed at root level now

        if (!payload || !tableName) {
            throw new Error("Missing payload or tableName for createRecord");
        }

        // Add scope parameter for ACL context (same as updateRecord)
        const scope = wsObj.scope ? `?sysparm_transaction_scope=${wsObj.scope}` : '';

        // 1:1 Pass-through: Send payload directly as request body
        const response = await safeFetch(`/api/now/table/${tableName}${scope}`, wsObj.instance.url, {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-UserToken': wsObj.instance.g_ck
            },
            body: JSON.stringify(payload)
        });

        const resp = await response.json();

        if (!response.ok) {
             if (resp && resp.error){
                throw new Error(resp.error.message || resp.error.detail);
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        if (resp.hasOwnProperty('result')) {
            t.addRow([
                new Date(), 'VS Code', `Created new record: <b>${payload.name}</b> in ${tableName}`
            ]);
            increaseTitlecounter();
            flashFavicon('images/icongreen48.png', 4);

            // Reconstruct necessary info for VS Code to map the file
            // We need to know which content field was used. We can find it in the payload keys that aren't 'name' or 'sys_scope'.
            // Or ideally, VS Code remembers what it sent. But for statelessness:
            const contentField = Object.keys(payload).find(k => k !== 'name' && k !== 'sys_scope') || 'script';

            const responseToVsCode = {
                action: 'createRecordResponse',
                agentRequestId: wsObj.agentRequestId, // Pass through for Agent API
                success: true,
                instance: wsObj.instance,
                newRecord: {
                    tableName: tableName,
                    sys_id: resp.result.sys_id,
                    name: payload.name, 
                    scope: resp.result.sys_scope?.value || payload.sys_scope,
                    content: payload[contentField],
                    field: contentField,
                    fieldType: 'script' // You might want to infer this or pass it through if needed
                }
            };
            ws.send(JSON.stringify(responseToVsCode));
        }
    } catch (error) {
        console.error('createRecord error:', error);
        t.addRow([new Date(), 'VS Code', `Create Record Error: ${error.message}`]);
        increaseTitlecounter();
        ws.send(JSON.stringify({
            action: 'createRecordResponse',
            agentRequestId: wsObj.agentRequestId, // Pass through for Agent API
            success: false,
            error: error.message
        }));
    }
}

async function checkNameExists(wsObj) {
    t.addRow([new Date(), wsObj.appName || 'VS Code', `Checking name exists: <b>${wsObj.name}</b> in ${wsObj.tableName}`]);
    increaseTitlecounter();
    
    try {
        const { tableName, name, scope, instance } = wsObj;

        if (!tableName || !name || !instance) {
            throw new Error("Missing tableName, name, or instance for checkNameExists");
        }

        // Query for existing record with same name in scope
        let query = `name=${encodeURIComponent(name)}`;
        if (scope) {
            query += `^sys_scope=${scope}`;
        }

        const response = await safeFetch(
            `/api/now/table/${tableName}?sysparm_query=${query}&sysparm_fields=sys_id,name&sysparm_limit=1`,
            instance.url,
            {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json',
                    'X-UserToken': instance.g_ck
                }
            }
        );

        const resp = await response.json();

        if (!response.ok) {
            if (resp && resp.error) {
                throw new Error(resp.error.message || resp.error.detail);
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const exists = resp.result && resp.result.length > 0;
        
        ws.send(JSON.stringify({
            action: 'checkNameExistsResponse',
            agentRequestId: wsObj.agentRequestId,
            success: true,
            exists: exists,
            existingRecord: exists ? resp.result[0] : null,
            originalRequest: wsObj
        }));

    } catch (error) {
        console.error('checkNameExists error:', error);
        t.addRow([new Date(), 'VS Code', `Check Name Exists Error: ${error.message}`]);
        increaseTitlecounter();
        ws.send(JSON.stringify({
            action: 'checkNameExistsResponse',
            agentRequestId: wsObj.agentRequestId,
            success: false,
            error: error.message,
            originalRequest: wsObj
        }));
    }
}

async function requestTableStructure(wsObj) {
    t.addRow([new Date(), wsObj.appName || 'VS Code', `Requesting table structure: <b>${wsObj.tableName}</b>`]);
    increaseTitlecounter();
    
    try {
        const tableName = wsObj.tableName;
        const instance = wsObj.instance;

        if (!tableName || !instance) {
            throw new Error("Missing tableName or instance for requestTableStructure");
        }

        const response = await safeFetch(`/api/now/ui/meta/${tableName}`, instance.url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-UserToken': instance.g_ck
            }
        });

        const resp = await response.json();

        if (!response.ok) {
            if (resp && resp.error){
                throw new Error(resp.error.message || resp.error.detail);
            }
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        if (resp.hasOwnProperty('result')) {
            t.addRow([
                new Date(), 'VS Code', `Received table structure for: <b>${tableName}</b>`
            ]);
            increaseTitlecounter();
            flashFavicon('images/icongreen48.png', 4);

            const responseToVsCode = {
                action: 'tableStructureResponse',
                agentRequestId: wsObj.agentRequestId,
                success: true,
                instance: instance,
                tableName: tableName,
                result: resp.result
            };
            ws.send(JSON.stringify(responseToVsCode));
        }
    } catch (error) {
        console.error('requestTableStructure error:', error);
        t.addRow([new Date(), 'VS Code', `Request Table Structure Error: ${error.message}`]);
        increaseTitlecounter();
        ws.send(JSON.stringify({
            action: 'tableStructureResponse',
            agentRequestId: wsObj.agentRequestId,
            success: false,
            error: error.message
        }));
    }
}

async function agentGetParentOptions(wsObj) {
    t.addRow([new Date(), wsObj.appName || 'VS Code', `Agent: Getting parent options for <b>${wsObj.tableName}</b>`]);
    increaseTitlecounter();
    
    try {
        const tableName = wsObj.tableName;
        const queryString = wsObj.queryString;
        const instance = wsObj.instance;

        if (!tableName || !instance) {
            throw new Error("Missing tableName or instance for agentGetParentOptions");
        }

        const response = await safeFetch(`/api/now/table/${tableName}?${queryString}`, instance.url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-UserToken': instance.g_ck
            }
        });

        const resp = await response.json();

        if (!response.ok) {
            throw new Error(resp?.error?.message || `HTTP error: ${response.status}`);
        }

        if (resp.hasOwnProperty('result')) {
            t.addRow([
                new Date(), 'VS Code', 
                `Agent API: Retrieved ${resp.result.length} parent options from <b>${tableName}</b>`
            ]);
            increaseTitlecounter();
            flashFavicon('images/icongreen48.png', 4);

            ws.send(JSON.stringify({
                action: 'agentParentOptionsResponse',
                agentRequestId: wsObj.agentRequestId,
                success: true,
                tableName: tableName,
                nameField: wsObj.nameField,
                result: resp.result
            }));
        }
    } catch (error) {
        console.error('agentGetParentOptions error:', error);
        t.addRow([new Date(), 'VS Code', `Agent Get Parent Options Error: ${error.message}`]);
        increaseTitlecounter();
        ws.send(JSON.stringify({
            action: 'agentParentOptionsResponse',
            agentRequestId: wsObj.agentRequestId,
            success: false,
            error: error.message
        }));
    }
}

async function agentQueryRecords(wsObj) {
    t.addRow([new Date(), wsObj.appName || 'VS Code', `Agent: Querying <b>${wsObj.tableName}</b>`]);
    increaseTitlecounter();
    
    try {
        const tableName = wsObj.tableName;
        const queryString = wsObj.queryString;
        const instance = wsObj.instance;

        if (!tableName || !instance) {
            throw new Error("Missing tableName or instance for agentQueryRecords");
        }

        const response = await safeFetch(`/api/now/table/${tableName}?${queryString}`, instance.url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-UserToken': instance.g_ck
            }
        });

        const resp = await response.json();

        if (!response.ok) {
            throw new Error(resp?.error?.message || `HTTP error: ${response.status}`);
        }

        if (resp.hasOwnProperty('result')) {
            t.addRow([
                new Date(), 'VS Code', 
                `Agent API: Query returned ${resp.result.length} record(s) from <b>${tableName}</b>`
            ]);
            increaseTitlecounter();
            flashFavicon('images/icongreen48.png', 4);

            ws.send(JSON.stringify({
                action: 'agentQueryRecordsResponse',
                agentRequestId: wsObj.agentRequestId,
                success: true,
                tableName: tableName,
                count: resp.result.length,
                records: resp.result
            }));
        }
    } catch (error) {
        console.error('agentQueryRecords error:', error);
        t.addRow([new Date(), 'VS Code', `Agent Query Records Error: ${error.message}`]);
        increaseTitlecounter();
        ws.send(JSON.stringify({
            action: 'agentQueryRecordsResponse',
            agentRequestId: wsObj.agentRequestId,
            success: false,
            error: error.message
        }));
    }
}

function refreshPreview(wsObj) {
    // Refresh browser tabs matching the test URLs
    const testUrls = wsObj.testUrls || [];
    const instance = wsObj.instance;
    
    t.addRow([
        new Date(), 'VS Code', `Refreshing preview for sys_id: ${wsObj.sys_id}`
    ]);
    increaseTitlecounter();
    flashFavicon('images/icongreen48.png', 2);
    
    // Refresh tabs matching the test URLs
    if (testUrls.length > 0) {
        testUrls.forEach(testUrl => {
            chrome.tabs.query({
                url: testUrl
            }, function (arrayOfTabs) {
                if (arrayOfTabs.length) {
                    arrayOfTabs.forEach(tab => {
                        chrome.tabs.reload(tab.id);
                    });
                    t.addRow([
                        new Date(), 'VS Code', `Refreshed ${arrayOfTabs.length} tab(s) matching preview URL`
                    ]);
                }
            });
        });
    }
    
    // Also try to refresh active tab if it's on the same instance
    if (instance?.url) {
        chrome.tabs.query({
            active: true,
            currentWindow: true
        }, function (arrayOfTabs) {
            if (arrayOfTabs.length && arrayOfTabs[0].url?.startsWith(instance.url)) {
                chrome.tabs.reload(arrayOfTabs[0].id);
            }
        });
    }
}

/**
 * Activate a tab by URL, optionally reload it, and optionally open if not found
 * @param {Object} wsObj - WebSocket message object containing:
 *   - url: string - URL pattern to find the tab (supports wildcards like *.service-now.com/*)
 *   - reload: boolean - Whether to reload the tab after activating (default: false)
 *   - openIfNotFound: boolean - Open URL in new tab if not found (default: false)
 *   - waitForLoad: boolean - Wait for page to finish loading before responding (default: false)
 *   - agentRequestId: string - Optional request ID for tracking
 */
function activateTab(wsObj) {
    const { url, reload = false, openIfNotFound = false, waitForLoad = false, agentRequestId } = wsObj;
    
    if (!url) {
        sendActivateTabResponse({ success: false, error: 'No URL provided' }, agentRequestId);
        return;
    }
    
    t.addRow([
        new Date(), wsObj.appName || 'VS Code', `Activating tab: <b>${url}</b>${reload ? ' (reload)' : ''}`
    ]);
    increaseTitlecounter();
    
    // Find tab by URL
    chrome.tabs.query({ url: url }, function(tabs) {
        if (tabs.length > 0) {
            const tab = tabs[0];
            activateAndOptionallyReload(tab, reload, waitForLoad, agentRequestId);
        } else if (openIfNotFound) {
            // Open new tab with the URL
            t.addRow([
                new Date(), 'Helper tab', `No tab found, opening: ${url}`
            ]);
            chrome.tabs.create({ url: url, active: true }, function(newTab) {
                if (waitForLoad) {
                    chrome.tabs.onUpdated.addListener(function listener(tabId, changeInfo) {
                        if (tabId === newTab.id && changeInfo.status === 'complete') {
                            chrome.tabs.onUpdated.removeListener(listener);
                            sendActivateTabResponse({
                                success: true,
                                tabId: newTab.id,
                                url: newTab.url,
                                title: newTab.title,
                                opened: true
                            }, agentRequestId);
                        }
                    });
                } else {
                    sendActivateTabResponse({
                        success: true,
                        tabId: newTab.id,
                        url: newTab.url,
                        opened: true
                    }, agentRequestId);
                }
            });
        } else {
            sendActivateTabResponse({
                success: false,
                error: `No tab found matching: ${url}`
            }, agentRequestId);
        }
    });
}

function activateAndOptionallyReload(tab, reload, waitForLoad, agentRequestId) {
    // Activate the tab
    chrome.tabs.update(tab.id, { active: true }, function(updatedTab) {
        if (chrome.runtime.lastError) {
            sendActivateTabResponse({
                success: false,
                error: chrome.runtime.lastError.message
            }, agentRequestId);
            return;
        }
        
        // Focus the window
        chrome.windows.update(tab.windowId, { focused: true }, function() {
            if (reload) {
                chrome.tabs.reload(tab.id, {}, function() {
                    if (waitForLoad) {
                        chrome.tabs.onUpdated.addListener(function listener(tabId, changeInfo) {
                            if (tabId === tab.id && changeInfo.status === 'complete') {
                                chrome.tabs.onUpdated.removeListener(listener);
                                // Small delay to ensure page is fully rendered
                                setTimeout(() => {
                                    chrome.tabs.get(tab.id, function(freshTab) {
                                        sendActivateTabResponse({
                                            success: true,
                                            tabId: freshTab.id,
                                            url: freshTab.url,
                                            title: freshTab.title,
                                            reloaded: true
                                        }, agentRequestId);
                                    });
                                }, 200);
                            }
                        });
                    } else {
                        sendActivateTabResponse({
                            success: true,
                            tabId: tab.id,
                            url: tab.url,
                            title: tab.title,
                            reloaded: true
                        }, agentRequestId);
                    }
                });
            } else {
                sendActivateTabResponse({
                    success: true,
                    tabId: tab.id,
                    url: tab.url,
                    title: tab.title
                }, agentRequestId);
            }
            
            t.addRow([
                new Date(), 'Helper tab', `Tab activated: <b>${tab.title || tab.url}</b>${reload ? ' (reloading)' : ''}`
            ]);
        });
    });
}

function sendActivateTabResponse(data, agentRequestId) {
    const response = {
        action: 'activateTabResponse',
        agentRequestId: agentRequestId,
        ...data
    };
    ws.send(JSON.stringify(response));
    
    if (!data.success) {
        t.addRow([
            new Date(), 'Helper tab', `Tab activation failed: <b>${data.error}</b>`
        ]);
    }
}

/**
 * Run a slash command on a ServiceNow tab
 * @param {Object} wsObj - WebSocket message object containing:
 *   - command: string - The slash command to run (e.g., "/tn", "/bg", "tn")
 *   - url: string - Optional URL pattern to find the tab (default: *.service-now.com/*)
 *   - tabId: number - Optional specific tab ID to target
 *   - autoRun: boolean - Whether to auto-execute the command (default: true)
 *   - agentRequestId: string - Optional request ID for tracking
 */
function runSlashCommand(wsObj) {
    const { command, url = 'https://*.service-now.com/*', tabId, autoRun = true, agentRequestId } = wsObj;
    
    if (!command) {
        sendSlashCommandResponse({ success: false, error: 'No command provided' }, agentRequestId);
        return;
    }
    
    const normalizedCommand = command.startsWith('/') ? command : '/' + command;
    
    t.addRow([
        new Date(), wsObj.appName || 'VS Code', `Running slash command: <b>${normalizedCommand}</b>${autoRun ? ' (auto-run)' : ''}`
    ]);
    increaseTitlecounter();
    
    if (tabId) {
        // Direct tab ID provided
        executeSlashCommandOnTab(tabId, normalizedCommand, autoRun, agentRequestId);
    } else {
        // Find tab by URL
        chrome.tabs.query({ url: url }, function(tabs) {
            if (tabs.length > 0) {
                executeSlashCommandOnTab(tabs[0].id, normalizedCommand, autoRun, agentRequestId);
            } else {
                sendSlashCommandResponse({
                    success: false,
                    error: `No ServiceNow tab found matching: ${url}`
                }, agentRequestId);
            }
        });
    }
}

function executeSlashCommandOnTab(tabId, command, autoRun, agentRequestId) {
    // First activate the tab
    chrome.tabs.update(tabId, { active: true }, function(tab) {
        if (chrome.runtime.lastError) {
            sendSlashCommandResponse({
                success: false,
                error: chrome.runtime.lastError.message
            }, agentRequestId);
            return;
        }
        
        // Focus the window
        chrome.windows.update(tab.windowId, { focused: true }, function() {
            // Send the slash command to the tab
            chrome.tabs.sendMessage(tabId, {
                method: 'snuProcessEvent',
                detail: {
                    action: 'runSlashCommand',
                    command: command,
                    autoRun: autoRun
                }
            }).then(() => {
                sendSlashCommandResponse({
                    success: true,
                    tabId: tabId,
                    command: command,
                    autoRun: autoRun
                }, agentRequestId);
                
                t.addRow([
                    new Date(), 'Helper tab', `✅ Slash command sent: <b>${command}</b>`
                ]);
            }).catch(err => {
                sendSlashCommandResponse({
                    success: false,
                    error: `Failed to send command: ${err.message}`
                }, agentRequestId);
            });
        });
    });
}

function sendSlashCommandResponse(data, agentRequestId) {
    const response = {
        action: 'runSlashCommandResponse',
        agentRequestId: agentRequestId,
        ...data
    };
    ws.send(JSON.stringify(response));
    
    if (!data.success) {
        t.addRow([
            new Date(), 'Helper tab', `Slash command failed: <b>${data.error}</b>`
        ]);
    }
}

/**
 * Switch ServiceNow context (update set, application, or domain)
 * @param {Object} wsObj - WebSocket message object containing:
 *   - instance: { url, g_ck } - ServiceNow instance info
 *   - switchType: string - 'updateset' | 'app' | 'application' | 'domain'
 *   - value: string - sys_id (for updateset) or app_id (for app/domain)
 *   - reloadTab: boolean - Whether to reload a ServiceNow tab after switching (default: true)
 *   - tabUrl: string - Optional URL pattern to find tab to reload
 *   - agentRequestId: string - Optional request ID for tracking
 */
async function switchContext(wsObj) {
    const { 
        instance, 
        switchType, 
        value, 
        reloadTab = true, 
        tabUrl = 'https://*.service-now.com/*',
        agentRequestId 
    } = wsObj;
    
    // Validate switch type
    const validTypes = ['updateset', 'application', 'domain'];
    if (!validTypes.includes(switchType)) {
        sendSwitchContextResponse({
            success: false,
            error: `Invalid switchType. Must be one of: ${validTypes.join(', ')}`
        }, agentRequestId);
        return;
    }
    
    // Determine payload key based on switch type
    // updateset: sys_id
    // application: app_id
    // domain: value
    let payloadKey;
    if (switchType === 'updateset') {
        payloadKey = 'sysId';
    } else if (switchType === 'application') {
        payloadKey = 'app_id';
    } else if (switchType === 'domain') {
        payloadKey = 'value';
    }
    
    if (!value) {
        sendSwitchContextResponse({
            success: false,
            error: 'No value provided'
        }, agentRequestId);
        return;
    }
    
    if (!instance?.url || !instance?.g_ck) {
        sendSwitchContextResponse({
            success: false,
            error: 'Missing instance URL or authentication token'
        }, agentRequestId);
        return;
    }
    
    const typeLabels = { 
        updateset: 'Update Set', 
        application: 'Application',
        domain: 'Domain' 
    };
    t.addRow([
        new Date(), wsObj.appName || 'VS Code', `Switching ${typeLabels[switchType]}: <b>${value}</b>`
    ]);
    increaseTitlecounter();
    flashFavicon('images/icongreen48.png', 2);
    
    try {
        const payload = {};
        payload[payloadKey] = value;
        
        const response = await safeFetch(`/api/now/ui/concoursepicker/${switchType}`, instance.url, {
            method: 'PUT',
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'Content-Type': 'application/json;charset=UTF-8',
                'X-WantSessionNotificationMessages': 'false',
                'X-UserToken': instance.g_ck
            },
            body: JSON.stringify(payload)
        });
        
        const data = await response.json();
        
        if (data?.error) {
            throw new Error(data.error.detail || data.error.message || 'Unknown error');
        }
        
        t.addRow([
            new Date(), 'Helper tab', `✅ ${typeLabels[switchType]} switched successfully`
        ]);
        
        // Optionally reload a ServiceNow tab
        if (reloadTab) {
            chrome.tabs.query({ url: tabUrl }, function(tabs) {
                if (tabs.length > 0) {
                    t.addRow([
                        new Date(), 'Helper tab', `Reloading tab: ${tabs[0].title || tabs[0].url}`
                    ]);
                    chrome.tabs.reload(tabs[0].id);
                }
            });
        }
        
        sendSwitchContextResponse({
            success: true,
            switchType: switchType,
            value: value,
            reloaded: reloadTab
        }, agentRequestId);
        
    } catch (error) {
        console.error('Switch context error:', error);
        
        sendSwitchContextResponse({
            success: false,
            switchType: switchType,
            value: value,
            error: error.message
        }, agentRequestId);
        
        t.addRow([
            new Date(), 'Helper tab', `❌ Switch failed: <b>${error.message}</b>`
        ]);
        flashFavicon('images/iconred48.png', 3);
    }
}

function sendSwitchContextResponse(data, agentRequestId) {
    const response = {
        action: 'switchContextResponse',
        agentRequestId: agentRequestId,
        ...data
    };
    ws.send(JSON.stringify(response));
}

// Generic REST API - allows calling any ServiceNow REST endpoint
async function agentRestApi(wsObj) {
    const { 
        instance, 
        endpoint, 
        method = 'GET', 
        body,
        queryParams,
        agentRequestId 
    } = wsObj;
    
    // Validate required params
    if (!endpoint) {
        sendAgentRestApiResponse({
            success: false,
            error: 'Missing required param: endpoint'
        }, agentRequestId);
        return;
    }
    
    if (!instance?.url || !instance?.g_ck) {
        sendAgentRestApiResponse({
            success: false,
            error: 'Missing instance URL or authentication token'
        }, agentRequestId);
        return;
    }
    
    // Validate HTTP method
    const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    const upperMethod = method.toUpperCase();
    if (!validMethods.includes(upperMethod)) {
        sendAgentRestApiResponse({
            success: false,
            error: `Invalid method. Must be one of: ${validMethods.join(', ')}`
        }, agentRequestId);
        return;
    }
    
    t.addRow([
        new Date(), wsObj.appName || 'VS Code', `Agent REST API: <b>${upperMethod}</b> ${endpoint}`
    ]);
    increaseTitlecounter();
    
    try {
        // Build URL with query params if provided
        let url = endpoint;
        if (queryParams && typeof queryParams === 'object') {
            const params = new URLSearchParams(queryParams).toString();
            url += (url.includes('?') ? '&' : '?') + params;
        }
        
        const fetchOptions = {
            method: upperMethod,
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'X-UserToken': instance.g_ck
            }
        };
        
        // Add body for methods that support it
        if (body && ['POST', 'PUT', 'PATCH'].includes(upperMethod)) {
            fetchOptions.body = JSON.stringify(body);
        }
        
        const response = await safeFetch(url, instance.url, fetchOptions);
        
        let data = null;
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            data = await response.json();
        } else {
            data = await response.text();
        }
        
        if (!response.ok) {
            const errorMsg = data?.error?.message || data?.error?.detail || 
                           (typeof data === 'string' ? data : `HTTP ${response.status}`);
            throw new Error(errorMsg);
        }
        
        t.addRow([
            new Date(), 'Helper tab', `✅ REST API: ${upperMethod} ${endpoint} - Status ${response.status}`
        ]);
        flashFavicon('images/icongreen48.png', 4);
        
        sendAgentRestApiResponse({
            success: true,
            status: response.status,
            data: data
        }, agentRequestId);
        
    } catch (error) {
        console.error('agentRestApi error:', error);
        t.addRow([
            new Date(), 'Helper tab', `❌ REST API Error: ${error.message}`
        ]);
        flashFavicon('images/iconred48.png', 3);
        
        sendAgentRestApiResponse({
            success: false,
            error: error.message
        }, agentRequestId);
    }
}

function sendAgentRestApiResponse(data, agentRequestId) {
    const response = {
        action: 'agentRestApiResponse',
        agentRequestId: agentRequestId,
        ...data
    };
    ws.send(JSON.stringify(response));
}

// Get current ServiceNow session context (scope, update set, user)
async function agentGetContext(wsObj) {
    const { instance, agentRequestId } = wsObj;
    
    if (!instance?.url || !instance?.g_ck) {
        sendAgentGetContextResponse({
            success: false,
            error: 'Missing instance URL or authentication token'
        }, agentRequestId);
        return;
    }
    
    t.addRow([
        new Date(), wsObj.appName || 'VS Code', `Agent: Getting current context`
    ]);
    increaseTitlecounter();
    
    try {
        // Get update set info
        const updateSetResponse = await safeFetch('/api/now/ui/concoursepicker/updateset', instance.url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-UserToken': instance.g_ck
            }
        });
        const updateSetData = await updateSetResponse.json();
        
        // Get application scope info
        const appResponse = await safeFetch('/api/now/ui/concoursepicker/application', instance.url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'X-UserToken': instance.g_ck
            }
        });
        const appData = await appResponse.json();
        
        // Extract current values from the responses
        const context = {
            updateSet: updateSetData?.result?.current?.displayValue || null,
            updateSetSysId: updateSetData?.result?.current?.value || null,
            scope: appData?.result?.current?.displayValue || null,
            scopeSysId: appData?.result?.current?.value || null,
            instance: instance.url.replace(/^https?:\/\//, '').replace(/\.service-now\.com.*$/, '')
        };
        
        t.addRow([
            new Date(), 'Helper tab', `✅ Context: Scope=<b>${context.scope}</b>, UpdateSet=<b>${context.updateSet}</b>`
        ]);
        flashFavicon('images/icongreen48.png', 4);
        
        sendAgentGetContextResponse({
            success: true,
            context: context
        }, agentRequestId);
        
    } catch (error) {
        console.error('agentGetContext error:', error);
        t.addRow([
            new Date(), 'Helper tab', `❌ Get Context Error: ${error.message}`
        ]);
        flashFavicon('images/iconred48.png', 3);
        
        sendAgentGetContextResponse({
            success: false,
            error: error.message
        }, agentRequestId);
    }
}

function sendAgentGetContextResponse(data, agentRequestId) {
    const response = {
        action: 'agentGetContextResponse',
        agentRequestId: agentRequestId,
        ...data
    };
    ws.send(JSON.stringify(response));
}

// Take screenshot of ServiceNow page
// Screenshots require activeTab permission - user must click extension icon first
function takeScreenshot(wsObj) {
    const tabId = wsObj.tabId;
    const url = wsObj.url;
    
    // Store the request for potential retry after user grants permission
    pendingScreenshotRequest = wsObj;
    
    t.addRow([
        new Date(), 'VS Code', 'Taking screenshot...'
    ]);
    increaseTitlecounter();
    flashFavicon('images/icongreen48.png', 2);

    // Priority: 1) explicit tabId, 2) last used tab (if still valid), 3) find by URL
    if (tabId) {
        // Direct tabId provided - get the tab and capture it
        chrome.tabs.get(tabId, function (tab) {
            if (chrome.runtime.lastError) {
                sendScreenshotError(`Tab not found: ${chrome.runtime.lastError.message}`, wsObj.agentRequestId);
                return;
            }
            captureTab(tab, wsObj);
        });
    } else if (lastScreenshotTabId) {
        // Try to reuse the last screenshot tab to avoid repeated permission prompts
        chrome.tabs.get(lastScreenshotTabId, function (tab) {
            if (chrome.runtime.lastError || !tab) {
                // Last tab no longer exists, fall back to URL search
                lastScreenshotTabId = null;
                findTabByUrl(url, wsObj);
            } else {
                // If a URL is provided, check if it matches or navigate to it
                if (url && !tab.url.startsWith(url.replaceAll('*', ''))) {
                    // Navigate the existing tab to the new URL
                    t.addRow([
                        new Date(), 'Helper tab', `Navigating existing tab to: ${url}`
                    ]);
                    chrome.tabs.update(tab.id, { url: url }, function (updatedTab) {
                        // Wait for navigation to complete
                        chrome.tabs.onUpdated.addListener(function listener(updatedTabId, changeInfo) {
                            if (updatedTabId === tab.id && changeInfo.status === 'complete') {
                                chrome.tabs.onUpdated.removeListener(listener);
                                setTimeout(() => captureTab(updatedTab || tab, wsObj), 500);
                            }
                        });
                    });
                } else {
                    captureTab(tab, wsObj);
                }
            }
        });
    } else if (url) {
        findTabByUrl(url, wsObj);
    } else {
        sendScreenshotError('No tabId or url provided', wsObj.agentRequestId);
    }
}

function findTabByUrl(url, wsObj) {
    if (!url) {
        sendScreenshotError('No URL provided and no previous screenshot tab available', wsObj.agentRequestId);
        return;
    }
    
    // URL provided - find matching tab
    chrome.tabs.query({ url: url }, function (tabs) {
        if (tabs.length > 0) {
            captureTab(tabs[0], wsObj);
        } else {
            // Fallback: open the URL in a new tab
            t.addRow([
                new Date(), 'VS Code', `No tab found, opening URL: ${url}`
            ]);
            chrome.tabs.create({ url: url, active: true }, function (newTab) {
                // Wait for the tab to finish loading
                chrome.tabs.onUpdated.addListener(function listener(tabId, changeInfo) {
                    if (tabId === newTab.id && changeInfo.status === 'complete') {
                        chrome.tabs.onUpdated.removeListener(listener);
                        // Small delay to ensure page is fully rendered
                        setTimeout(() => {
                            captureTab(newTab, wsObj);
                        }, 1000);
                    }
                });
            });
        }
    });
}

function captureTab(tab, wsObj) {
    const agentRequestId = wsObj?.agentRequestId;
    
    // First, make sure the tab is focused so we can capture it
    chrome.tabs.update(tab.id, { active: true }, function (updatedTab) {
        if (chrome.runtime.lastError) {
            sendScreenshotError(`Failed to activate tab: ${chrome.runtime.lastError.message}`, agentRequestId);
            return;
        }
        // Use updatedTab to get current windowId (in case tab was moved)
        const currentWindowId = updatedTab?.windowId || tab.windowId;
        chrome.windows.update(currentWindowId, { focused: true }, function () {
            // Small delay to ensure the tab is fully visible
            setTimeout(() => {
                chrome.tabs.captureVisibleTab(currentWindowId, { format: 'png' }, function (dataUrl) {
                    if (chrome.runtime.lastError) {
                        const errorMsg = chrome.runtime.lastError.message;
                        if (errorMsg.includes('activeTab') || errorMsg.includes('permission')) {
                            const msg = 'Screenshot requires permission. Click the SN Utils extension icon on the tab you want to capture, then retry.';
                            sendScreenshotError(msg, agentRequestId);
                            // Show alert on the ServiceNow tab to guide user
                            showAlertOnTab(tab.id, '📸 Click the SN Utils extension icon (puzzle piece → SN Utils) to grant screenshot permission, then retry.', 'warning', 10000);
                        } else {
                            sendScreenshotError(errorMsg, agentRequestId);
                        }
                        return;
                    }

                    if (!dataUrl) {
                        sendScreenshotError('Failed to capture screenshot - no data returned', agentRequestId);
                        return;
                    }

                    // Remember this tab for future screenshots
                    lastScreenshotTabId = tab.id;
                    pendingScreenshotRequest = null;
                    
                    handleScreenshotSuccess(dataUrl, tab, agentRequestId);
                });
            }, 200);
        });
    });
}

function handleScreenshotSuccess(dataUrl, tab, agentRequestId) {
    // Extract base64 data (remove "data:image/png;base64," prefix)
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
    
    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `screenshot_${timestamp}.png`;

    // Send screenshot data back to VS Code
    const response = {
        action: 'screenshotResponse',
        agentRequestId: agentRequestId, // Pass through for Agent API
        imageData: base64Data,
        fileName: fileName,
        url: tab.url,
        tabUrl: tab.url,
        tabTitle: tab.title
    };

    ws.send(JSON.stringify(response));

    t.addRow([
        new Date(), 'Helper tab', `Screenshot captured: <b>${tab.title}</b><br/>Sent to VS Code for saving`
    ]);
    flashFavicon('images/icongreen48.png', 2);
}

function showAlertOnTab(tabId, message, type = 'warning', timeout = 5000) {
    chrome.tabs.sendMessage(tabId, {
        method: 'snuProcessEvent',
        detail: {
            action: 'showAlert',
            message: message,
            type: type,
            timeout: timeout
        }
    }).catch(err => {
        console.warn('Could not send alert to tab:', err);
    });
}

/**
 * Upload an attachment (e.g., screenshot) to a ServiceNow record
 * @param {Object} wsObj - WebSocket message object containing:
 *   - instance: { url, g_ck } - ServiceNow instance info
 *   - tableName: string - Target table (e.g., 'incident')
 *   - recordSysId: string - sys_id of the record to attach to
 *   - fileName: string - Name for the attachment
 *   - imageData: string - Base64 encoded image data (without data URL prefix)
 *   - contentType: string - MIME type (default: 'image/png')
 *   - agentRequestId: string - Optional request ID for tracking
 */
async function uploadAttachment(wsObj) {
    const { instance, tableName, recordSysId, fileName, imageData, contentType = 'image/png', agentRequestId } = wsObj;
    
    t.addRow([
        new Date(), wsObj.appName || 'VS Code', `Uploading attachment: <b>${fileName}</b> to ${tableName}/${recordSysId}`
    ]);
    increaseTitlecounter();
    flashFavicon('images/icongreen48.png', 2);
    
    try {
        // Validate required fields
        if (!instance?.url || !instance?.g_ck) {
            throw new Error('Missing instance URL or authentication token');
        }
        if (!tableName || !recordSysId) {
            throw new Error('Missing table name or record sys_id');
        }
        if (!imageData) {
            throw new Error('Missing image data');
        }
        
        // Convert base64 to binary blob (chunked for memory efficiency)
        const cleanedData = imageData.replace(/^data:image\/(png|jpeg);base64,/, '');
        const sliceSize = 1024;
        const byteCharacters = atob(cleanedData);
        const bytesLength = byteCharacters.length;
        const slicesCount = Math.ceil(bytesLength / sliceSize);
        const byteArrays = new Array(slicesCount);
        
        for (let sliceIndex = 0; sliceIndex < slicesCount; ++sliceIndex) {
            const begin = sliceIndex * sliceSize;
            const end = Math.min(begin + sliceSize, bytesLength);
            const bytes = new Array(end - begin);
            for (let offset = begin, i = 0; offset < end; ++i, ++offset) {
                bytes[i] = byteCharacters[offset].charCodeAt(0);
            }
            byteArrays[sliceIndex] = new Uint8Array(bytes);
        }
        const blob = new Blob(byteArrays, { type: contentType });
        
        // Build the attachment API URL
        const attachmentUrl = `/api/now/attachment/file?table_name=${encodeURIComponent(tableName)}&table_sys_id=${encodeURIComponent(recordSysId)}&file_name=${encodeURIComponent(fileName)}`;
        
        const response = await safeFetch(attachmentUrl, instance.url, {
            method: 'POST',
            headers: {
                'Cache-Control': 'no-cache',
                'Accept': 'application/json',
                'Content-Type': contentType,
                'X-UserToken': instance.g_ck || undefined
            },
            body: blob
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const result = await response.json();
        
        // Send success response back to VS Code
        const successResponse = {
            action: 'uploadAttachmentResponse',
            agentRequestId: agentRequestId,
            success: true,
            attachment: result.result,
            tableName: tableName,
            recordSysId: recordSysId,
            fileName: fileName
        };
        ws.send(JSON.stringify(successResponse));
        
        t.addRow([
            new Date(), 'Helper tab', `✅ Attachment uploaded: <b>${fileName}</b><br/>sys_id: ${result.result?.sys_id || 'unknown'}`
        ]);
        flashFavicon('images/icongreen48.png', 2);
        
    } catch (error) {
        console.error('Upload attachment error:', error);
        
        const errorResponse = {
            action: 'uploadAttachmentResponse',
            agentRequestId: agentRequestId,
            success: false,
            error: error.message,
            tableName: tableName,
            recordSysId: recordSysId,
            fileName: fileName
        };
        ws.send(JSON.stringify(errorResponse));
        
        t.addRow([
            new Date(), 'Helper tab', `❌ Attachment upload failed: <b>${error.message}</b>`
        ]);
        flashFavicon('images/iconred48.png', 3);
    }
}

function sendScreenshotError(errorMessage, agentRequestId) {
    const response = {
        action: 'screenshotResponse',
        agentRequestId: agentRequestId, // Pass through for Agent API
        error: errorMessage
    };
    ws.send(JSON.stringify(response));
    
    t.addRow([
        new Date(), 'Helper tab', `Screenshot error: <b>${errorMessage}</b>`
    ]);
    flashFavicon('images/iconred48.png', 3);
}

var favIconIsFlashing = false;

function flashFavicon(src, flashes) {

    setIntervalX(function () {
        currentsource = favIconIsFlashing ? '/images/icon32.png' : src;
        changeFavicon(currentsource);
        favIconIsFlashing = !favIconIsFlashing;
    }, 900, flashes);

}

function setIntervalX(callback, delay, repetitions) {
    var x = 0;
    var intervalID = window.setInterval(function () {

        callback();

        if (++x === repetitions) {
            window.clearInterval(intervalID);
            favIconIsFlashing = false;
        }
    }, delay);
}
var eventCount = 0;

function increaseTitlecounter() {
    document.title = "[" + (++eventCount) + "] sn-scriptsync SN Utils by arnoudkooi.com";
}

function changeFavicon(src) {
    var link = document.createElement('link'),
        oldLink = document.getElementById('dynamic-favicon');
    link.id = 'dynamic-favicon';
    link.rel = 'shortcut icon';
    link.href = src;
    if (oldLink) {
        document.head.removeChild(oldLink);
    }
    document.head.appendChild(link);
}


/**
 * @function snuStartBackgroundScript
 * @param  {String} script   {the script that should be executed}
 * @param  {String} instance   {instance info required for communication}
 * @param  {String} action {name of the action)}
 * @return {undefined}
 */
function snuStartBackgroundScript(script, instance, action) {
    if (!isApprovedInstanceUrl(instance.url)) {
        t.addRow([new Date(), 'Helper tab', `Blocked: unapproved instance URL for background script`]);
        return;
    }
    try {
        const baseUrl = new URL(instance.url);
        if (baseUrl.protocol !== 'https:') throw new Error('Only HTTPS allowed');
        document.querySelector('base').setAttribute('href', baseUrl.origin + '/');
    } catch (e) {
        t.addRow([new Date(), 'Helper tab', `Invalid instance URL: ${e.message}`]);
        return;
    }

    try {
        safeFetch('/sys.scripts.do', instance.url, {
            method: 'POST',
            headers: {
                'Cache-Control': 'no-cache',
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({
                script: script,
                runscript: "Run script",
                sysparm_ck: instance.g_ck,
                sys_scope: instance?.scope || "e24e9692d7702100738dc0da9e6103dd",
                quota_managed_transaction: "on"
            }).toString()
        }).then(response => response.text())
            .then((data) => {
                data = data.replace("<HTML><BODY>", "").replace("</BODY><HTML>", "");
                if (action == "executeBackgroundScript"){ 
                    let response = {
                        action : "responseFromBackgroundScript",
                        instance,
                        data
                    }
                    ws.send(JSON.stringify(response));
                    data = "View response in VS Code";
                };
                increaseTitlecounter();
                t.addRow([
                    new Date(), 'VS Code', 'Background Script Executed: <br />' + data
                ]);
            })
            .catch((error) => {
                console.error('snuStartBackgroundScript error:', error);
                t.addRow([
                    new Date(), 'VS Code', 'Background Script failed (' + error + ')<br />'
                ]);
            });

    } catch (error) {
        console.error('snuStartBackgroundScript error:', error);
        t.addRow([
            new Date(), 'VS Code', 'Background Script failed (' + error + ')<br />'
        ]);
    }
}

function updateActionScript(wsObj) {

    var val = wsObj.content || "";
    val = JSON.stringify(val).slice(1, -1);

    var scrpt = `
    //set state of action to draft
    var grAction = new GlideRecord('sys_hub_action_type_definition');
    grAction.addEncodedQuery("RLQUERYsys_hub_step_instance.action,>=1^sys_id=${wsObj.sys_id}^ENDRLQUERY");
    grAction.query();
    while (grAction.next()) {
        grAction.setValue('state','draft');
        grAction.update();
    }
    //update the variable
    var grVar = new GlideRecord('sys_variable_value');
    grVar.addEncodedQuery("document_key=${wsObj.sys_id}^variable.labelINscript,command");
    grVar.setLimit(1);
    grVar.query();
    while (grVar.next()) {
        grVar.setValue('value', "${val}");
        grVar.update();
    }
    `;
    snuStartBackgroundScript(scrpt, wsObj.instance);
}

function updateVar(wsObj) {

    var val = wsObj.content || "";
    val = JSON.stringify(val).slice(1, -1);
    var scrpt = `
    var grVar = new GlideRecord('sys_variable_value');
    grVar.addEncodedQuery("document_key=${wsObj.sys_id}^variable.element=${wsObj.fieldName}");
    grVar.setLimit(1);
    grVar.query();
    while (grVar.next()) {
        grVar.setValue('value', "${val}");
        grVar.update();
    }
    //keep the updates in sync...
    var rec = new GlideRecord('${wsObj.tableName}');
    rec.get('${wsObj.sys_id}');
    var um = new GlideUpdateManager2();
    um.saveRecord(rec);`;
    snuStartBackgroundScript(scrpt, wsObj.instance);

}

function getFormData(object) {
    const formData = new FormData();
    Object.keys(object).forEach(key => formData.append(key, object[key]));
    return formData;
}

//=============================================================================
// STORAGE FUNCTIONS - All use chrome.storage.local
//=============================================================================

// Global setting (not instance-specific)
function setGlobalSetting(theName, theValue) {
    chrome.storage.local.set({ [theName]: theValue });
}

// Get global setting
function getGlobalSetting(theName, callback) {
    chrome.storage.local.get(theName, result => callback(result[theName]));
}


function setInstanceLists() {

    setInstanceList("allowed", scriptsyncinstances.allowed);
    setInstanceList("blocked", scriptsyncinstances.blocked);
    function setInstanceList(listtype, arr) {
        let cntnt = ''
        arr.forEach(instance => {
            cntnt += `<li>${instance} <a href='#' data-url='${instance}' class='${listtype}'>❌</a></li>`;
        })
        document.querySelector('#intanceslist' + listtype).innerHTML = cntnt || '<li>-none-</li>';

        document.querySelectorAll('#intanceslist' + listtype + ' a')?.forEach(a => {
            a.addEventListener('click', e => {
                e.preventDefault();
                deleteInstance(a.className, a.dataset.url);
            });
        });
    }
}

function deleteInstance(listtype, instance) {
    if (confirm(`Delete ${instance} from ${listtype} list?`)) {
        let newlist = scriptsyncinstances[listtype].filter(item => item !== instance);
        scriptsyncinstances[listtype] = newlist;
        setGlobalSetting('scriptsyncinstances', scriptsyncinstances);
        setInstanceLists();
    }
}
