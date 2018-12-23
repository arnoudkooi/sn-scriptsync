/**
Scoped GlideRecord is used for database operations.
*/
class GlideRecord {

    /**
    Creates an instance of the GlideRecord class for the specified table.
    @param {String} tableName -The table to be used.
    
    */
    constructor(tableName){ /** todo */ }
    
    
    /**
    Adds a filter to return active records.
    @return Filter to return active records.
    */
    addActiveQuery(){ /** todo */ }
    
    /**
    Adds an encoded query to other queries that may have been set.
    @param {String} query -An encoded query string
    @return Method does not return a value
    */
    addEncodedQuery(query){ /** todo */ }
    
    /**
    Applies a pre-defined GlideDBFunctionBuilder object to a record.
    @param {Object} function -A GlideDBFunctionBuilder object that defines a SQL operation.
    @return Method does not return a value
    */
    addFunction(function_){ /** todo */ }
    
    /**
    Adds a filter to return records based on a relationship in a related table.
    @param {String} joinTable -Table name
    @param {Object} primaryField -(Optional) If other than sys_id, the primary field
    @param {Object} joinTableField -(Optional) If other than sys_id, the field that joins the tables.
    @return A filter that lists records where the relationships match.
    */
    addJoinQuery(joinTable, primaryField, joinTableField){ /** todo */ }
    
    /**
    A filter that specifies records where the value of the field passed in the parameter is
    not null.
    @param {String} fieldName -The name of the field to be checked.
    @return A filter that specifies records where the value of the field passed in the                parameter is not null.
    */
    addNotNullQuery(fieldName){ /** todo */ }
    
    /**
    Adds a filter to return records where the value of the specified field is
    null.
    @param {String} fieldName -The name of the field to be checked.
    @return The query condition added to the GlideRecord.
    */
    addNullQuery(fieldName){ /** todo */ }
    
    /**
    Provides the ability to build a request, which when executed, returns the rows from the
    specified table, that match the request.
    @param {String} name -Table field name.
    @param {Object} value -Value on which to query (not case-sensitive).
    @return The query condition added to the GlideRecord.
    */
    addQuery(name, value){ /** todo */ }
    
    /**
    Provides the ability to build a request, which when executed, returns the rows from the
    specified table, that match the request.
    @param {String} name -Table field name.
    @param {String} operator -Query operator. The available values are dependent on the data type of the
    @param {Object} value -Value on which to query (not case-sensitive).
    @return The query condition that was added to the GlideRecord.
    */
    addQuery(name, operator, value){ /** todo */ }
    
    /**
    Adds a filter to return records using an encoded query string.
    @param {String} query -An encoded query string
    @return The query condition added to the GlideRecord.
    */
    addQuery(query){ /** todo */ }
    
    /**
    Determines if the Access Control Rules, which include the user's roles, permit
    inserting new records in this table.
    @return True if the user's roles permit creation of new records in this                  table.
    */
    canCreate(){ /** todo */ }
    
    /**
    Determines if the Access Control Rules, which include the user's roles, permit deleting
    records in this table.
    @return True if the user's roles permit deletions of records in this table.
    */
    canDelete(){ /** todo */ }
    
    /**
    Determines if the Access Control Rules, which include the user's roles, permit reading
    records in this table.
    @return True if the user's roles permit reading records from this table.
    */
    canRead(){ /** todo */ }
    
    /**
    Determines if the Access Control Rules, which include the user's roles, permit editing
    records in this table.
    @return True if the user's roles permit writing to records from this table.
    */
    canWrite(){ /** todo */ }
    
    /**
    Sets a range of rows to be returned by subsequent queries.
    @param {Number} firstRow -The first row to include.
    @param {Number} lastRow -The last row to include.
    @param {Boolean} forceCount -If true, the getRowCount() method will return all possible records.
    @return Method does not return a value
    */
    chooseWindow(firstRow, lastRow, forceCount){ /** todo */ }
    
    /**
    Returns the number of milliseconds since January 1, 1970, 00:00:00 GMT for a duration
    field. Does not require the creation of a GlideDateTime object because the duration field is
    already a GlideDateTime object.
    @return Number of milliseconds since January 1, 1970, 00:00:00 GMT.
    */
    dateNumericValue(){ /** todo */ }
    
    /**
    Deletes multiple records that satisfy the query condition.
    @return Method does not return a value
    */
    deleteMultiple(){ /** todo */ }
    
    /**
    Deletes the current record.
    @return True if the record was deleted; false if no record was found to delete.
    */
    deleteRecord(){ /** todo */ }
    
    /**
    Defines a GlideRecord based on the specified expression of 'name = value'.
    @param {Object} name -Column name
    @param {Object} value -Value to match. If value is not specified, then the expression used is
    @return True if one or more matching records was found. False if no matches                found.
    */
    get(name, value){ /** todo */ }
    
    /**
    Returns the dictionary attributes for the specified field.
    @param {String} fieldName -Field name for which to return the dictionary attributes
    @return Dictionary attributes
    */
    getAttribute(fieldName){ /** todo */ }
    
    /**
    Returns the table's label.
    @return Table's label
    */
    getClassDisplayValue(){ /** todo */ }
    
    /**
    Retrieves the display value for the current record.
    @return The display value for the current record.
    */
    getDisplayValue(){ /** todo */ }
    
    /**
    Returns the element's descriptor.
    @return Element's descriptor
    */
    getED(){ /** todo */ }
    
    /**
    Retrieves the GlideElement object for the specified field.
    @param {String} columnName -Name of the column to get the element from.
    @return The GlideElement for the specified column of the current record.
    */
    getElement(columnName){ /** todo */ }
    
    /**
    Retrieves the query condition of the current result set as an encoded query string.
    @return The encoded query as a string.
    */
    getEncodedQuery(){ /** todo */ }
    
    /**
    Returns the field's label.
    @return Field's label
    */
    getLabel(){ /** todo */ }
    
    /**
    Retrieves the last error message. If there is no last error message, null is returned.
    @return The last error message as a string.
    */
    getLastErrorMessage(){ /** todo */ }
    
    /**
    Retrieves a link to the current record.
    @param {Boolean} noStack -If true, the sysparm_stack parameter is not appended to the link. The parameter
    @return A link to the current record as a string.
    */
    getLink(noStack){ /** todo */ }
    
    /**
    Retrieves the class name for the current record.
    @return The class name.
    */
    getRecordClassName(){ /** todo */ }
    
    /**
    Retrieves the number of rows in the query result.
    @return The number of rows.
    */
    getRowCount(){ /** todo */ }
    
    /**
    Retrieves the name of the table associated with the GlideRecord.
    @return The table name
    */
    getTableName(){ /** todo */ }
    
    /**
    Gets the primary key of the record, which is usually the sys_id unless otherwise
    specified.
    @return The unique primary key as a String, or null if the key is null.
    */
    getUniqueValue(){ /** todo */ }
    
    /**
    Retrieves the string value of an underlying element in a field.
    @param {String} name -The name of the field to get the value from.
    @return The value of the field.
    */
    getValue(name){ /** todo */ }
    
    /**
    Determines if there are any more records in the GlideRecord object.
    @return True if there are more records in the query result set.
    */
    hasNext(){ /** todo */ }
    
    /**
    Creates an empty record suitable for population before an insert.
    @return Method does not return a value
    */
    initialize(){ /** todo */ }
    
    /**
    Inserts a new record using the field values that have been set for the current record.
    @return Unique ID of the inserted record, or null if the record is not                inserted.
    */
    insert(){ /** todo */ }
    
    /**
    Checks to see if the current database action is to be aborted.
    @return True if the current database action is to be aborted
    */
    isActionAborted(){ /** todo */ }
    
    /**
    Checks if the current record is a new record that has not yet been inserted into the
    database.
    @return True if the record is new and has not been inserted into the database.
    */
    isNewRecord(){ /** todo */ }
    
    /**
    Determines if the table exists.
    @return True if table is valid or if record was successfully retrieved. False if table                is invalid or record was not successfully retrieved.
    */
    isValid(){ /** todo */ }
    
    /**
    Determines if the specified field is defined in the current table.
    @param {String} columnName -The name of the the field.
    @return True if the field is defined for the current table.
    */
    isValidField(columnName){ /** todo */ }
    
    /**
    Determines if current record is a valid record.
    @return True if the current record is valid. False if past the end of the record set.
    */
    isValidRecord(){ /** todo */ }
    
    /**
    Creates a new GlideRecord record, sets the default values for the fields, and assigns a
    unique ID to the record.
    @return Method does not return a value
    */
    newRecord(){ /** todo */ }
    
    /**
    Moves to the next record in the GlideRecord object.
    @return True if moving to the next record is successful. False if there are no more                records in the result set.
    */
    next(){ /** todo */ }
    
    /**
    Retrieves the current operation being performed, such as insert, update, or delete.
    @return The current operation.
    */
    operation(){ /** todo */ }
    
    /**
    Specifies an orderBy column.
    @param {String} name -The column name used to order the records in this GlideRecord object.
    @return Method does not return a value
    */
    orderBy(name){ /** todo */ }
    
    /**
    Specifies a decending orderBy column.
    @param {String} name -The column name to be used to order the records in a GlideRecord object.
    @return Method does not return a value
    */
    orderByDesc(name){ /** todo */ }
    
    /**
    Runs the query against the table based on the filters specified by addQuery,
    addEncodedQuery, etc.
    @param {Object} field -The column name to query on.
    @param {Object} value -The value to query for.
    @return Method does not return a value
    */
    query(field, value){ /** todo */ }
    
    /**
    Sets a flag to indicate if the next database action (insert, update, delete) is to be
    aborted. This is often used in business rules.
    @param {Boolean} b -True to abort the next action. False if the action is to be allowed.
    @return Method does not return a value
    */
    setAbortAction(b){ /** todo */ }
    
    /**
    Sets the duration field to a number of milliseconds since January 1, 1970, 00:00:00 GMT
    for a duration field. Does not require the creation of a GlideDateTime object because the
    duration field is already a GlideDateTime object.
    @param {Number} milliseconds -Number of milliseconds spanned by the duration.
    @return Method does not return a value
    */
    setDateNumericValue(milliseconds){ /** todo */ }
    
    /**
    Sets the limit for number of records are fetched by the GlideRecord query.
    @param {Number} maxNumRecords -The maximum number of records to fetch.
    @return Method does not return a value
    */
    setLimit(maxNumRecords){ /** todo */ }
    
    /**
    Sets sys_id value for the current record.
    @param {String} guid -The GUID to be assigned to the current record.
    @return Method does not return a value
    */
    setNewGuidValue(guid){ /** todo */ }
    
    /**
    Sets the value of the field with the specified name to the specified value.
    @param {String} name -Name of the field.
    @param {Object} value -The value to assign to the field.
    @return Method does not return a value
    */
    setValue(name, value){ /** todo */ }
    
    /**
    Enables or disables the running of business rules, script engines, and
    audit.
    @param {Boolean} enable -If true (default), enables business rules. If false, disables business
    @return Method does not return a value
    */
    setWorkflow(enable){ /** todo */ }
    
    /**
    Updates the GlideRecord with any changes that have been made. If the record does not
    already exist, it is inserted.
    @param {String} reason (Optional) -The reason for the update. The reason is displayed in the audit record.
    @return Unique ID of the new or updated record. Returns null if the update                fails.
    */
    update(reason){ /** todo */ }
    
    /**
    Updates each GlideRecord in the list with any changes that have been made.
    @return Method does not return a value
    */
    updateMultiple(){ /** todo */ }
    
    /**
    Moves to the next record in the GlideRecord. Provides the same functionality as
    next(), it is  intended to be used in cases where the GlideRecord has a
    column named next.
    @return True if there are more records in the query set.
    */
    _next(){ /** todo */ }
    
    /**
    Identical to query(). This method is intended to be used on tables
    where there is a column named query, which would interfere with using the
    query() method.
    @param {Object} name -Column name on which to query
    @param {Object} value -Value for which to query
    @return Method does not return a value
    */
    _query(field, value){ /** todo */ }}