//output of this background script is saved in metaDataRelations.json
var tFields = {}
var sf = [
  'script',
  'script_plain',
  'script_server',
  'script_client',
  'email_script',
  'html_script',
  'xml',
  'html',
  'html_template',
  'template',
  'json',
  'css',
  'condition_string',
  'expression',
  'graphql_schema',
  'json_translations',
  'translated_html',
]


var pa = new PAUtils();
var t = pa.getTableDecendants('sys_metadata')
for (var i = 0; i < t.length; i++) {
  var au = new ArrayUtil();
  var g = new GlideRecord(t[i]);
  g.initialize();
  tFields[t[i]] = { "label" :  g.getClassDisplayValue() }
  for (var f in g) {
    var ed = g[f].getED();
    var ft = ed.getInternalType();
    var l = g[f].getLabel();
    if (ft == 'reference') {
      var ref = ed.getReference();  
      if (['sys_scope','sys_package'].indexOf(f) == -1)  {
        if (!tFields[t[i]].hasOwnProperty('referenceFields')) tFields[t[i]].referenceFields = {};
        tFields[t[i]].referenceFields[f] = { table : ref, label : l } ;
      }
    }
    else if (au.contains(sf, ft)) {

        if (!tFields[t[i]].hasOwnProperty('codeFields')) tFields[t[i]].codeFields = {};
        tFields[t[i]].codeFields[f] = { label : l, type: ft };
    }
  }
}


// first determine known groups
//From scriptinclude 
var tableGroups = {};
var idx = 0;
function group(label, tables){
    var name = 'i' + idx + '_' + label.toLowerCase().replace(/[^A-Za-z0-9 ]/g,"").replace("  ",' ').replace(" ",'_');
    tableGroups[name] = label;
    for (i=0; i<tables.length;i++){
      if (tFields.hasOwnProperty(tables[i]))
        tFields[tables[i]].group = name;
      else if (tables[i].includes('*')){
        var tableStart = tables[i].replace("*","");
        var loopTables = Object.keys(tFields);
        for (var i = 0; i < loopTables.length; i++){
            if (loopTables[i].startsWith(tableStart) &&  !tFields[loopTables[i]].hasOwnProperty('group') )
                tFields[loopTables[i]].group = name;
        }
      }
    }
    idx++;
}

    group('Data Model', [
        "sys_db_object",        // Table
        "sys_dictionary",       // Field
        "sys_m2m",		        // Many to Many Definition
        "sys_relationship",	    // Relationship
        "sys_metric"            //Time series metric definitions"
    ]),

    group('Forms & UI', [
        "sys_ui_form",			// Form	should intercept the click and allow you to select a table then show the form designer.
        "sys_ui_list",	        // List Layout	Needs to be intercepted and taken to a slush bucket
        "sys_ui_list_control",	// List Control	Maybe should be accessed via a list you have already created
        "sys_ui_related_list",	// Related List	Needs to be intercepted and taken to a slush bucket
        "sys_ui_style",			// Style
        "sys_ui_context_menu",	// Context Menu
        "sysrule_view",			// View Rule
        "sys_ui_page",	        // UI Page
        "cmn_schedule_page",	// Schedule Page
        "cmn_timeline_page",	// Timeline Page
        "cmn_map_page",			// Map Page
        "sys_template",	        // Template
        "sys_ui_macro",	        // UI Macro
        "sys_ui_formatter",		// UI Formatter
        "sys_embedded_help_content", // Embedded Help
        "sys_embedded_help_qualifier", // Help Qualifier
        "sys_embedded_tour_guide"    //Guided Tour
    ]),

    group('Server Development', [
        "sys_script",               // Business Rule
        "sys_script_include",       // Script Include
        "sys_ui_action",            // UI Action (Server)
        "sys_data_policy2",         // Data Policy (Server)
        "sys_processor",	        // Processor
        "sysauto_script",	        // Scheduled Script Execution	Do not include, accessed through scheduled job
        "sysevent_register",	    // Event Registration
        "sysevent_script_action",	// Script Action
        "sys_script_fix", 		    // Fix Script
        "sys_extension_point", 		// Extension Point Definition
        "sys_extension_instance" 	//Extension Point Instance
    ]),

    group('Client Development', [
        "sys_script_client",	    // Client Script
        "sys_ui_policy",	        // UI Policy
        "sys_ui_script",	        // UI Script
        "dl_u_assignment",	        // Assignment Data Lookup	Data Lookup
        "dl_u_priority",	        // Priority Data Lookup	Data Lookup
        "dl_definition", 	        // Data Lookup Definitions	Data Lookup
        "sys_ui_extension_point",   // UI Extension Point
        "sys_ui_extension_instance",
        "sys_client_extension_point", // Client Extension Point
        "sys_client_extension_instance"
    ]),

    group('Now Experience', [
        "sys_ux_page_registry",     // UX Application
        "sys_ux_app_config",         // UX App Configuration
        "sys_ux*"
    ]),

    group('Access Control', [
        "sys_user_role",	        // Role
        "sys_security_acl",	        // Access Control
        "sys_public"                // Public Page	Makes a page public, no login required
    ]),

    group('Properties', [
        "sys_properties",		    // System Property
        "sys_properties_category",	// System Property Category
        "sys_ui_message"            // Message
    ]),

    group('Navigation', [
        "sys_app_application",      // Application menu
        "sys_app_module",           // Application Module
        "sys_ui_application",       // Application Menu (Mobile)
        "sys_ui_module"             // Application Module (Mobile)
    ]),

    group('Notifications', [
        "sysevent_email_action",	// Email Notification
        "sysevent_email_template",	// Email Template
        "sysevent_in_email_action"	// Inbound Email Actions
    ]),

    group('Service Portal', [
        "sp_portal",                    //Portal
        "sp_page",                      //Page in portal
        "sp_widget",                    //Portal page widgets
        "sp_theme",                     //Portal themes
        "sp_css",                       //Portal CSS
        "sp_js_include",                //JS includes
        "sp_dependency",                 //Widget Dependency
        "sp_*"
    ]),

    group('Content Management', [
        "content_site",	                // Site
        "content_link",	                // Content Link
        "content_theme",                // Content Theme
        "content_block_detail",	        // Detailed Content	Do not include, opened from interceptor on content_block
        "content_block_flash",	        // Flash Movie
        "content_block_header",	        // Header
        "content_block_iframe",	        // IFrames
        "content_block_lists",	        // List of Content	Do not include, opened from interceptor on content_block
        "content_block_menu",	        // Navigation Menu	Do not include, opened from interceptor on content_block
        "content_block_programmatic",   // Dynamic Content	Do not include, opened from interceptor on content_block
        "content_block_static",	        // Static Content	Do not include, opened from interceptor on content_block
        "content_css",		            // Style Sheet
        "sys_portal_page",		        // Portal Page	This is the homepage table
        "db_image",			            // Image
        "db_video",			            // Video
        "db_audio"			            // Audio
    ]),

    group('Service Catalog', [
        "sc_cat_item",	                // Catalog Item
        "sc_cat_item_producer",	        // Record Producer
        "sc_catalog",		            // Catalog
        "sc_category",		            // Category
        "catalog_ui_policy",	        // Catalog UI Policy
        "item_option_new_set",	        // Variable Set
        "sc_cat_item_content",	        // Content Item
        "sc_cat_item_delivery_plan",    // Execution Plan
        "sc_cat_item_guide",	        // Order guide
        "catalog_script_client",        // Catalog Client Script
        "sc_cat_*"
    ]),

    group('Reporting', [
        "sys_report",	                // Report
        "metric_definition",	        // Metric Definition
        "sysauto_report",	            // Scheduled Email of Report
        "sys_report_chart_color",       // Chart Colors
        "sys_report_color",	            // Color Definition
        "sys_report_range"	            // Range
    ]),

    group('Inbound Integrations', [
        "sys_data_source",	            // Data Source
        "v_ws_creator",                 // Import Set Web Service (Create)
        "v_ws_editor",                  // Import Set Web Service (List)
        "scheduled_import_set",	        // Scheduled Data Import
        "sys_ws_definition",	        // Scripted REST API
        "sys_ws_operation",             // Scripted REST Resource
        "sys_web_service",              // Scripted SOAP Web Service
        "sys_transform_map",	        // Table Transform Map
    ]),

    group('Outbound Integrations', [
        "sys_export_definition",        // Export Definition
        "sys_export_set",               // Export Set
        "sys_export_target",	        // Export Target
        "sys_rest_message",	            // REST Message
        "scheduled_data_export",        // Scheduled Data Export
        "sys_soap_message",	            // SOAP Message
    ]),

    group('Virtual Agent', [
        "sys_cb_topic"					// TOPIC (Conversation Builder)
    ]),

    group('Natural Language Understanding', [
        "sys_nlu_model"                // Model
    ]),

    group('Flow Designer', [
        "sys_hub_flow",
        "sys_hub_action_type_definition",
        "sys_alias",
        "sys_hub*"
    ]),

    group('Workflow', [
        "wf_workflow",			    // Workflow	Workflow
        "wf_workflow_schedule",		// Workflow Schedule
        "wf_element_activity"       //Orchestration activities
    ]),

    group('Schedules', [
        "cmn_schedule",		        // Schedule
        "cmn_schedule_blackout",	// Blackout Schedule
        "cmn_schedule_maintenance",	// Maintenance Schedule
        "risk_conditions",		    // Risk Conditions
        "cmn_relative_duration",	// Relative Duration
    ]),

    group('MID Server', [
        "ecc_agent_script_include",        // MID Server Script Include
        "ecc_agent_script_file",	       // MID Server Script File
        "ecc_agent_property",              // MID Server Property
        "ecc_agent_capability",            // MID Server Capability
        "ecc_agent_capability_value_test", // MID Server Capability Value Test
        "ecc_agent_ip_range",              // MID Server IP Range
        "ecc_agent_application",            // MID Server Application
        "ecc_*"
    ])


// form here determine relations between tables, with based on related lists

// var rls = {}
// var refFields = {};
// var grRl = new GlideRecord('sys_ui_related_list_entry');
// grRl.addEncodedQuery("list_id.nameINjavascript:new PAUtils().getTableDecendants('sys_metadata')^related_listNOT LIKEREL:");
// grRl.orderBy('list_id.name');
// grRl.orderBy('related_list');
// grRl.query();
// while (grRl.next()) {

//     //firstRelatedLists per table
//     var rl = grRl.getValue('related_list');
//     var table = grRl.list_id.name.getValue();
//     if (!rls.hasOwnProperty(table)) rls[table] = [];
//     if (!(rls[table].indexOf(rl) > -1)) rls[table].push(rl);

//     // referenceFields
//     var refTable = rl.split('.')[0];
//     var refField = rl.split('.')[1];
//     if (!refFields.hasOwnProperty(refTable)) refFields[refTable] = [];
//     if (!(refFields[refTable].indexOf(refField) > -1)) refFields[refTable].push(refField);


// }

// end of related list determination


// var metaDataRelations = {
//   tableFields : tFields,
//   tableGroups : tableGroups,
//   relatedListsPerTable : rls,
//   referenceFields : refFields
// }
var metaDataRelations = {
    tableFields : tFields,
    tableGroups : tableGroups
}
gs.print(JSON.stringify(metaDataRelations));