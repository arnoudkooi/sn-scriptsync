/**
GlideAggregate enables you to easily create database aggregation
queries.
*/
class GlideAggregate {

    /**
    Creates a GlideAggregate object on the specified table.
    @param {String} tableName -Name of the table.
    
    */
    constructor(tableName){ /** todo */ }
    
    
    /**
    Adds an aggregate.
    @param {String} agg -Name of the aggregate to add, for example, COUNT, MIN, or MAX
    @param {String} name -(Optional) Name of the column to aggregate. Null is the default.
    @return Method does not return a value
    */
    addAggregate(agg, name){ /** todo */ }
    
    /**
    Adds an encoded query to the other queries that may have been set for this
    aggregate.
    @param {String} query -An encoded query to add to the aggregate.
    @return Method does not return a value
    */
    addEncodedQuery(query){ /** todo */ }
    
    /**
    Adds a not null query to the aggregate.
    @param {String} fieldname -The name of the field.
    @return The scoped query condition.
    */
    addNotNullQuery(fieldName){ /** todo */ }
    
    /**
    Adds a null query to the aggregate.
    @param {String} fieldName -The name of the field.
    @return The scoped query condition.
    */
    addNullQuery(fieldName){ /** todo */ }
    
    /**
    Adds a query to the aggregate.
    @param {String} name -The query to add.
    @param {String} operator -The operator for the query.
    @param {String} value -The list of values to include in the query.
    @return The query condition.
    */
    addQuery(name, operator, value){ /** todo */ }
    
    /**
    Adds a trend for a field.
    @param {String} fieldName -The name of the field for which trending should occur.
    @param {String} timeInterval -The time interval for the trend. The following choices are available: Year,
    @return Method does not return a value
    */
    addTrend(fieldName, timeInterval){ /** todo */ }
    
    /**
    Gets the value of an aggregate from the current record.
    @param {String} agg -The type of the aggregate, for example, SUM or Count.
    @param {String} name -Name of the field to get the aggregate from.
    @return The value of the aggregate.
    */
    getAggregate(agg, name){ /** todo */ }
    
    /**
    Gets the query necessary to return the current aggregate.
    @return The encoded query to get the aggregate.
    */
    getAggregateEncodedQuery(){ /** todo */ }
    
    /**
    Retrieves the encoded query.
    @return The encoded query.
    */
    getEncodedQuery(){ /** todo */ }
    
    /**
    Retrieves the number of rows in the GlideAggregate object.
    @return The number of rows in the GlideAggregate object.
    */
    getRowCount(){ /** todo */ }
    
    /**
    Retrieves the table name associated with this GlideAggregate object.
    @return The table name.
    */
    getTableName(){ /** todo */ }
    
    /**
    Gets the value of a field.
    @param {String} name -The name of the field.
    @return The value of the field.
    */
    getValue(name){ /** todo */ }
    
    /**
    Provides the name of a field to use in grouping the aggregates.
    @param {String} name -Name of the field.
    @return Method does not return a value
    */
    groupBy(name){ /** todo */ }
    
    /**
    Determines if there are any more records in the GlideAggregate object.
    @return True if there are more results in the query set.
    */
    hasNext(){ /** todo */ }
    
    /**
    Moves to the next record in the GlideAggregate.
    @return True if there are more records in the query set; otherwise, false.
    */
    next(){ /** todo */ }
    
    /**
    Orders the aggregates using the value of the specified field. The field will also be
    added to the group-by list.
    @param {String} name -Name of the field to order the aggregates by.
    @return Method does not return a value
    */
    orderBy(name){ /** todo */ }
    
    /**
    Orders the aggregates based on the specified aggregate and field.
    @param {String} agg -Type of aggregation.
    @param {String} fieldName -Name of the field to aggregate.
    @return Method does not return a value
    */
    orderByAggregate(agg, fieldName){ /** todo */ }
    
    /**
    Sorts the aggregates in descending order based on the specified field. The field will
    also be added to the group-by list.
    @param {String} name -Name of the field.
    @return Method does not return a value
    */
    orderByDesc(name){ /** todo */ }
    
    /**
    Issues the query and gets the results.
    @return Method does not return a value
    */
    query(){ /** todo */ }
    
    /**
    Sets whether the results are to be grouped.
    @param {Boolean} b -When true the results are grouped.
    @return Method does not return a value
    */
    setGroup(b){ /** todo */ }}