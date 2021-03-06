'use strict';

var $npm = {
    con: require('manakin').local,
    result: require('./result'),
    special: require('./special'),
    context: require('./cnContext'),
    events: require('./events'),
    utils: require('./utils'),
    connect: require('./connect'),
    query: require('./query'),
    task: require('./task')
};

var $arr = require('./array');

/**
 * @class Database
 * @description
 *
 * Represents the database protocol, extensible via event {@link event:extend extend}.
 * This type is not available directly, it can only be created via the library's base call.
 *
 * **IMPORTANT:**
 *
 * For any given connection, you should only create a single {@link Database} object in a separate module,
 * to be shared in your application (see the code example below). If instead you keep creating the {@link Database}
 * object dynamically, your application will suffer from loss in performance, and will be getting a warning in a
 * development environment (when `NODE_ENV` = `development`):
 *
 * `WARNING: Creating a duplicate database object for the same connection.`
 *
 * If you ever see this warning, rectify your {@link Database} object initialization, so there is only one object
 * per connection details. See the example provided below.
 *
 * See also: property `noWarnings` in {@link module:pg-promise Initialization Options}.
 *
 * @param {String|Object} cn
 * Database connection details, which can be:
 *
 * - a configuration object
 * - a connection string
 *
 * For details see {@link https://github.com/vitaly-t/pg-promise/wiki/Connection-Syntax Connection Syntax}.
 *
 * @param {} [dc]
 * Database Context.
 *
 * Any object or value to be propagated through the protocol, to allow implementations
 * and event handling that depend on the database context.
 *
 * This is mainly to facilitate the use of multiple databases which may need separate protocol
 * extensions, or different implementations within a single task / transaction callback,
 * depending on the database context.
 *
 * @returns {Database}
 * 
 * @see
 *
 * {@link Database.query query},
 * {@link Database.none none},
 * {@link Database.one one},
 * {@link Database.oneOrNone oneOrNone},
 * {@link Database.many many},
 * {@link Database.manyOrNone manyOrNone},
 * {@link Database.any any},
 * {@link Database.func func},
 * {@link Database.proc proc},
 * {@link Database.result result},
 * {@link Database.map map},
 * {@link Database.each each},
 * {@link Database.stream stream},
 * {@link Database.task task},
 * {@link Database.tx tx},
 * {@link Database.connect connect},
 * {@link Database.$config $config},
 * {@link event:extend extend}
 *
 * @example
 * // Proper way to initialize and share the Database object
 *
 * // Loading and initializing the library:
 * var pgp = require('pg-promise')({
 *     // Initialization Options
 * });
 *
 * // Preparing the connection details:
 * var cn = "postgres://username:password@host:port/database";
 *
 * // Creating a new database instance from the connection details:
 * var db = pgp(cn);
 *
 * // Exporting the database object for shared use:
 * module.exports = db;
 */
function Database(cn, dc, config) {

    checkForDuplicates(cn, config);
    setErrorHandler(config);

    var $p = config.promise;

    /**
     * @method Database.connect
     *
     * @description
     * Acquires a new or existing connection, based on the current connection parameters.
     *
     * This method creates a shared connection for executing a chain of queries against it.
     * The connection must be released in the end of the chain by calling method `done()` on the connection object.
     *
     * This is an older, low-level approach to chaining queries on the same connection.
     * A newer and safer approach is via methods {@link Database.task task} and {@link Database.tx tx} (for transactions),
     * which allocate and release the shared connection automatically.
     *
     * **NOTE:** Even though this method exposes a {@link external:Client Client} object via property `client`,
     * you cannot call `client.end()` directly, or it will print an error into the console:
     * `Abnormal client.end() call, due to invalid code or failed server connection.`
     * You should only call method `done()` to release the connection.
     *
     * @param {object} [options]
     * Connection options. **Added in v.4.3.4**
     *
     * @param {boolean} [options.direct=false]
     * Creates the connection directly, through the {@link external:Client Client}, bypassing the connection pool.
     *
     * By default, all connections are acquired from the connection pool. If you set this option, the library will instead
     * create a new {@link external:Client Client} object directly (separately from the pool), and then call its `connect` method.
     *
     * **WARNING:**
     *
     * Do not use this option for regular query execution, because it exclusively occupies one physical connection,
     * and therefore cannot scale. This option is only suitable for global connection usage, such as database event listeners.
     *
     * @returns {external:Promise}
     * A promise object that represents the connection result:
     *  - resolves with the complete {@link Database} protocol, extended with:
     *    - property `client` of type {@link external:Client Client} that represents the open connection
     *    - method `done()` that must be called in the end, in order to release the connection
     *  - rejects with a connection-related error when it fails to connect.
     *
     * @see
     * {@link Database.task},
     * {@link Database.tx}
     *
     * @example
     *
     * var sco; // shared connection object;
     *
     * db.connect()
     *     .then(function (obj) {
     *         // obj.client = new connected Client object;
     *
     *         sco = obj; // save the connection object;
     *
     *         // execute all the queries you need:
     *         return sco.any('SELECT * FROM Users');
     *     })
     *     .then(function (data) {
     *         // success
     *     })
     *     .catch(function (error) {
     *         // error
     *     })
     *     .finally(function () {
     *         // release the connection, if it was successful:
     *         if (sco) {
     *             sco.done();
     *         }
     *     });
     *
     */
    this.connect = function (options) {
        var ctx = createContext();
        var self = {
            // Generic query method;
            query: function (query, values, qrm) {
                if (!ctx.db) {
                    throw new Error("Cannot execute a query on a disconnected client.");
                }
                return config.$npm.query.call(this, ctx, query, values, qrm);
            },
            // Connection release method;
            done: function () {
                if (!ctx.db) {
                    throw new Error("Cannot invoke done() on a disconnected client.");
                }
                ctx.disconnect();
            }
        };
        var method = (options && options.direct) ? 'direct' : 'pool';
        return config.$npm.connect[method](ctx)
            .then(function (db) {
                ctx.connect(db);
                self.client = db.client;
                extend(ctx, self);
                return self;
            });
    };

    /**
     * @method Database.query
     *
     * @description
     * Executes a generic query request that expects the return data according to parameter `qrm`.
     *
     * @param {String|Object} query
     * Query to be executed, which can any of the following types:
     * - A non-empty query string
     * - Prepared Statement `{name, text, values, ...}` or {@link PreparedStatement} object
     * - Parameterized Query `{text, values, ...}` or {@link ParameterizedQuery} object
     * - {@link QueryFile} object
     *
     * @param {array|value} [values]
     * Query formatting parameters.
     *
     * When `query` is of type `string` or a {@link QueryFile} object, the `values` can be:
     * - a single value - to replace all `$1` occurrences
     * - an array of values - to replace all `$1`, `$2`, ... variables
     * - an object - to apply $[Named Parameters] formatting
     *
     * When `query` is a Prepared Statement or a Parameterized Query (or their class types),
     * and `values` is not `null` or `undefined`, it is automatically set within such object,
     * as an override for its internal `values`.
     *
     * @param {queryResult} [qrm=queryResult.any]
     * {@link queryResult Query Result Mask}
     *
     * @returns {external:Promise}
     * A promise object that represents the query result.
     *
     * When the query result is an array, it is extended with a hidden property `duration`
     * - query duration in milliseconds.
     */
    this.query = function (query, values, qrm) {
        var self = this, ctx = createContext();
        return config.$npm.connect.pool(ctx)
            .then(function (db) {
                ctx.connect(db);
                return config.$npm.query.call(self, ctx, query, values, qrm);
            })
            .then(function (data) {
                ctx.disconnect();
                return data;
            })
            .catch(function (error) {
                ctx.disconnect();
                return $p.reject(error);
            });
    };

    /**
     * @member {object} Database.$config
     * @readonly
     * @description
     * **Added in v.4.4.7**
     *
     * This is a hidden property, to help integrating type {@link Database} directly with third-party libraries.
     *
     * Properties available in the object:
     * - `pgp` - instance of the entire library after initialization
     * - `options` - the library's {@link module:pg-promise Initialization Options} object
     * - `promiseLib` - instance of the promise library that's used
     * - `promise` - generic promise interface that uses `promiseLib` via 3 basic methods:
     *   - `promise((resolve, reject)=>{})` - to create a new promise
     *   - `promise.resolve(value)` - to resolve with a value
     *   - `promise.reject(value)` - to reject with a value
     * - `version` - this library's version _(added in 4.4.8)_
     * - `$npm` _(hidden property)_ - internal module cache _(added in 4.5.1)_
     */
    $npm.utils.addReadProp(this, '$config', config, true);

    extend(createContext(), this); // extending root protocol;

    function createContext() {
        return new $npm.context(cn, dc, config.options);
    }

    function singleValue(value, cb, thisArg) {
        if (typeof cb === 'function') {
            value = value.then(function (data) {
                return cb.call(thisArg, data);
            });
        }
        return value;
    }

    ////////////////////////////////////////////////////
    // Injects additional methods into an access object,
    // extending the protocol's base method 'query'.
    function extend(ctx, obj) {

        /**
         * @method Database.none
         * @description
         * Executes a query that expects no data to be returned.
         * If the query returns any kind of data, the method rejects.
         *
         * @param {String|Object} query
         * Query to be executed, which can any of the following types:
         * - A non-empty query string
         * - Prepared Statement `{name, text, values, ...}` or {@link PreparedStatement} object
         * - Parameterized Query `{text, values, ...}` or {@link ParameterizedQuery} object
         * - {@link QueryFile} object
         *
         * @param {array|value} [values]
         * Query formatting parameters.
         *
         * When `query` is of type `string` or a {@link QueryFile} object, the `values` can be:
         * - a single value - to replace all `$1` occurrences
         * - an array of values - to replace all `$1`, `$2`, ... variables
         * - an object - to apply $[Named Parameters] formatting
         *
         * When `query` is a Prepared Statement or a Parameterized Query (or their class types),
         * and `values` is not `null` or `undefined`, it is automatically set within such object,
         * as an override for its internal `values`.
         *
         * @returns {external:Promise}
         * A promise object that represents the query result:
         * - when no records are returned, it resolves with `null`
         * - when any data is returned, it rejects with {@link errors.QueryResultError QueryResultError}
         * = `No return data was expected.`
         */
        obj.none = function (query, values) {
            return obj.query.call(this, query, values, $npm.result.none);
        };

        /**
         * @method Database.one
         * @description
         * Executes a query that expects exactly one row of data.
         * When 0 or more than 1 rows are returned, the method rejects.
         *
         * @param {String|Object} query
         * Query to be executed, which can any of the following types:
         * - A non-empty query string
         * - Prepared Statement `{name, text, values, ...}` or {@link PreparedStatement} object
         * - Parameterized Query `{text, values, ...}` or {@link ParameterizedQuery} object
         * - {@link QueryFile} object
         *
         * @param {array|value} [values]
         * Query formatting parameters.
         *
         * When `query` is of type `string` or a {@link QueryFile} object, the `values` can be:
         * - a single value - to replace all `$1` occurrences
         * - an array of values - to replace all `$1`, `$2`, ... variables
         * - an object - to apply $[Named Parameters] formatting
         *
         * When `query` is a Prepared Statement or a Parameterized Query (or their class types),
         * and `values` is not `null` or `undefined`, it is automatically set within such object,
         * as an override for its internal `values`.
         *
         * @param {function} [cb]
         * **Added in 4.6.0**
         *
         * Value transformation callback, to allow in-line value change.
         * When specified, the return value replaces the original resolved value.
         *
         * The function takes only one parameter - value resolved from the query.
         *
         * @param {} [thisArg]
         * **Added in 4.6.0**
         *
         * Value to use as `this` when executing the transformation callback.
         *
         * @returns {external:Promise}
         * A promise object that represents the query result:
         * - when 1 row is returned, it resolves with that row as a single object;
         * - when no rows are returned, it rejects with {@link errors.QueryResultError QueryResultError}
         * = `No data returned from the query.`
         * - when multiple rows are returned, it rejects with {@link errors.QueryResultError QueryResultError}
         * = `Multiple rows were not expected.`
         *
         * @example
         *
         * // a query with in-line value transformation:
         * db.one('INSERT INTO Events VALUES($1) RETURNING id', [123], event=>event.id)
         *     .then(data=> {
         *         // data = a new event id, rather than an object with it
         *     });
         *
         * @example
         *
         * // a query with in-line value transformation + conversion:
         * db.one('SELECT count(*) FROM Users', null, value=>parseInt(value.count))
         *     .then(data=> {
         *         // data = a proper integer, rather than an object with a string
         *     });
         *
         */
        obj.one = function (query, values, cb, thisArg) {
            var v = obj.query.call(this, query, values, $npm.result.one);
            return singleValue(v, cb, thisArg);
        };

        /**
         * @method Database.many
         * @description
         * Executes a query that expects one or more rows.
         * When the query returns no data, the method rejects.
         *
         * @param {String|Object} query
         * Query to be executed, which can any of the following types:
         * - A non-empty query string
         * - Prepared Statement `{name, text, values, ...}` or {@link PreparedStatement} object
         * - Parameterized Query `{text, values, ...}` or {@link ParameterizedQuery} object
         * - {@link QueryFile} object
         *
         * @param {array|value} [values]
         * Query formatting parameters.
         *
         * When `query` is of type `string` or a {@link QueryFile} object, the `values` can be:
         * - a single value - to replace all `$1` occurrences
         * - an array of values - to replace all `$1`, `$2`, ... variables
         * - an object - to apply $[Named Parameters] formatting
         *
         * When `query` is a Prepared Statement or a Parameterized Query (or their class types),
         * and `values` is not `null` or `undefined`, it is automatically set within such object,
         * as an override for its internal `values`.
         *
         * @returns {external:Promise}
         * A promise object that represents the query result:
         * - when 1 or more rows are returned, it resolves with the array of rows
         * - when no rows are returned, it rejects with {@link errors.QueryResultError QueryResultError}
         * = `No data returned from the query.`
         */
        obj.many = function (query, values) {
            return obj.query.call(this, query, values, $npm.result.many);
        };

        /**
         * @method Database.oneOrNone
         * @description
         * Executes a query that expects 0 or 1 rows.
         * When the query returns more than 1 row, the method rejects.
         *
         * @param {String|Object} query
         * Query to be executed, which can any of the following types:
         * - A non-empty query string
         * - Prepared Statement `{name, text, values, ...}` or {@link PreparedStatement} object
         * - Parameterized Query `{text, values, ...}` or {@link ParameterizedQuery} object
         * - {@link QueryFile} object
         *
         * @param {array|value} [values]
         * Query formatting parameters.
         *
         * When `query` is of type `string` or a {@link QueryFile} object, the `values` can be:
         * - a single value - to replace all `$1` occurrences
         * - an array of values - to replace all `$1`, `$2`, ... variables
         * - an object - to apply $[Named Parameters] formatting
         *
         * When `query` is a Prepared Statement or a Parameterized Query (or their class types),
         * and `values` is not `null` or `undefined`, it is automatically set within such object,
         * as an override for its internal `values`.
         *
         * @param {function} [cb]
         * **Added in 4.6.0**
         *
         * Value transformation callback, to allow in-line value change.
         * When specified, the return value replaces the original resolved value.
         *
         * The function takes only one parameter - value resolved from the query.
         *
         * @param {} [thisArg]
         * **Added in 4.6.0**
         *
         * Value to use as `this` when executing the transformation callback.
         *
         * @returns {external:Promise}
         * A promise object that represents the query result:
         * - when no rows are returned, it resolves with `null`
         * - when 1 row is returned, it resolves with that row as a single object
         * - when multiple rows are returned, it rejects with {@link errors.QueryResultError QueryResultError}
         * = `Multiple rows were not expected.`
         *
         * @see
         * {@link Database.one one},
         * {@link Database.none none}
         *
         * @example
         *
         * // a query with in-line value transformation:
         * db.oneOrNone('SELECT id FROM Events WHERE type = $1', ['entry'], e => e ? e.id : null)
         *     .then(data=> {
         *         // data = the event id or null (rather than object or null)
         *     });
         *
         */
        obj.oneOrNone = function (query, values, cb, thisArg) {
            var v = obj.query.call(this, query, values, $npm.result.one | $npm.result.none);
            return singleValue(v, cb, thisArg);
        };

        /**
         * @method Database.manyOrNone
         * @description
         * Executes a query that expects any number of rows.
         *
         * @param {String|Object} query
         * Query to be executed, which can any of the following types:
         * - A non-empty query string
         * - Prepared Statement `{name, text, values, ...}` or {@link PreparedStatement} object
         * - Parameterized Query `{text, values, ...}` or {@link ParameterizedQuery} object
         * - {@link QueryFile} object
         *
         * @param {array|value} [values]
         * Query formatting parameters.
         *
         * When `query` is of type `string` or a {@link QueryFile} object, the `values` can be:
         * - a single value - to replace all `$1` occurrences
         * - an array of values - to replace all `$1`, `$2`, ... variables
         * - an object - to apply $[Named Parameters] formatting
         *
         * When `query` is a Prepared Statement or a Parameterized Query (or their class types),
         * and `values` is not `null` or `undefined`, it is automatically set within such object,
         * as an override for its internal `values`.
         *
         * @returns {external:Promise}
         * A promise object that represents the query result:
         * - when no rows are returned, it resolves with an empty array
         * - when 1 or more rows are returned, it resolves with the array of rows.
         *
         * @see {@link Database.any any}
         *
         */
        obj.manyOrNone = function (query, values) {
            return obj.query.call(this, query, values, $npm.result.many | $npm.result.none);
        };

        /**
         * @method Database.any
         * @description
         * Executes a query that expects any number of rows.
         * This is simply a shorter alias for method {@link Database.manyOrNone manyOrNone}.
         *
         * @param {String|Object} query
         * Query to be executed, which can any of the following types:
         * - A non-empty query string
         * - Prepared Statement `{name, text, values, ...}` or {@link PreparedStatement} object
         * - Parameterized Query `{text, values, ...}` or {@link ParameterizedQuery} object
         * - {@link QueryFile} object
         *
         * @param {array|value} [values]
         * Query formatting parameters.
         *
         * When `query` is of type `string` or a {@link QueryFile} object, the `values` can be:
         * - a single value - to replace all `$1` occurrences
         * - an array of values - to replace all `$1`, `$2`, ... variables
         * - an object - to apply $[Named Parameters] formatting
         *
         * When `query` is a Prepared Statement or a Parameterized Query (or their class types),
         * and `values` is not `null` or `undefined`, it is automatically set within such object,
         * as an override for its internal `values`.
         *
         * @returns {external:Promise}
         * A promise object that represents the query result:
         * - when no rows are returned, it resolves with an empty array
         * - when 1 or more rows are returned, it resolves with the array of rows.
         *
         * @see
         * {@link Database.manyOrNone manyOrNone},
         * {@link Database.map map},
         * {@link Database.each each}
         *
         */
        obj.any = function (query, values) {
            return obj.query.call(this, query, values, $npm.result.any);
        };

        /**
         * @method Database.result
         * @description
         * Executes a query without any expectation for the return data, to resolve with the
         * original $[Result] object when successful.
         *
         * @param {String|Object} query
         * Query to be executed, which can any of the following types:
         * - A non-empty query string
         * - Prepared Statement `{name, text, values, ...}` or {@link PreparedStatement} object
         * - Parameterized Query `{text, values, ...}` or {@link ParameterizedQuery} object
         * - {@link QueryFile} object
         *
         * @param {array|value} [values]
         * Query formatting parameters.
         *
         * When `query` is of type `string` or a {@link QueryFile} object, the `values` can be:
         * - a single value - to replace all `$1` occurrences
         * - an array of values - to replace all `$1`, `$2`, ... variables
         * - an object - to apply $[Named Parameters] formatting
         *
         * When `query` is a Prepared Statement or a Parameterized Query (or their class types),
         * and `values` is not `null` or `undefined`, it is automatically set within such object,
         * as an override for its internal `values`.
         *
         * @param {function} [cb]
         * **Added in 4.6.2**
         *
         * Value transformation callback, to allow in-line value change.
         * When specified, the return value replaces the original resolved value.
         *
         * The function takes only one parameter - value resolved from the query.
         *
         * @param {} [thisArg]
         * **Added in 4.6.2**
         *
         * Value to use as `this` when executing the transformation callback.
         *
         * @returns {external:Promise}
         * A promise object that represents the query result:
         * - resolves with the original $[Result] object, extended with
         *   property `duration` - query duration in milliseconds.
         *
         * @example
         *
         * // use of value transformation:
         * // deleting rows and returning the number of rows deleted
         * db.result('DELETE FROM Events WHERE id = $1', [123], r=>r.rowCount)
         *     .then(data=> {
         *         // data = number of rows that were deleted
         *     });
         *
         * @example
         *
         * // use of value transformation:
         * // getting only column details from a table
         * db.result('SELECT * FROM Users LIMIT 0', null, r=>r.fields)
         *     .then(data=> {
         *         // data = array of column descriptors
         *     });
         *
         */
        obj.result = function (query, values, cb, thisArg) {
            var v = obj.query.call(this, query, values, $npm.special.cache.resultQuery);
            return singleValue(v, cb, thisArg);
        };

        /**
         * @method Database.stream
         * @description
         * Custom data streaming, with the help of $[pg-query-stream].
         *
         * This method doesn't work with the $[Native Bindings], and if option `pgNative`
         * is set, it will reject with `Streaming doesn't work with Native Bindings.`
         *
         * @param {QueryStream} qs
         * Stream object of type $[QueryStream].
         *
         * @param {Database.streamInitCB} initCB
         * Stream initialization callback.
         *
         * It is invoked with the same `this` context as the calling method.
         *
         * @returns {external:Promise}
         * Result of the streaming operation.
         *
         * Once the streaming has finished successfully, the method resolves with
         * `{processed, duration}`:
         * - `processed` - total number of rows processed;
         * - `duration` - streaming duration, in milliseconds.
         *
         * Possible rejections messages:
         * - `Invalid or missing stream object.`
         * - `Invalid stream state.`
         * - `Invalid or missing stream initialization callback.`
         */
        obj.stream = function (qs, init) {
            return obj.query.call(this, qs, init, $npm.special.cache.streamQuery);
        };

        /**
         * @method Database.func
         * @description
         * Executes a query against a database function by its name: `SELECT * FROM funcName(values)`.
         *
         * @param {string} funcName
         * Name of the function to be executed.
         *
         * @param {array|value} [values]
         * Parameters for the function - one value or an array of values.
         *
         * @param {queryResult} [qrm=queryResult.any] - {@link queryResult Query Result Mask}.
         *
         * @returns {external:Promise}
         * Result of the query call, according to parameter `qrm`.
         *
         * @see
         * {@link Database.query query},
         * {@link Database.proc proc}
         */
        obj.func = function (funcName, values, qrm) {
            return obj.query.call(this, {
                funcName: funcName
            }, values, qrm);
        };

        /**
         * @method Database.proc
         * @description
         * Executes a query against a stored procedure via its name: `select * from procName(values)`,
         * expecting back 0 or 1 rows.
         *
         * The method simply forwards into {@link Database.func func}`(procName, values, queryResult.one|queryResult.none)`.
         *
         * @param {string} procName
         * Name of the stored procedure to be executed.
         *
         * @param {array|value} [values]
         * Parameters for the procedure - one value or an array of values.
         *
         * @param {function} [cb]
         * **Added in 4.6.0**
         *
         * Value transformation callback, to allow in-line value change.
         * When specified, the return value replaces the original resolved value.
         *
         * The function takes only one parameter - value resolved from the query.
         *
         * @param {} [thisArg]
         * **Added in 4.6.0**
         *
         * Value to use as `this` when executing the transformation callback.
         *
         * @returns {external:Promise}
         * The same result as method {@link Database.oneOrNone oneOrNone}.
         *
         * @see
         * {@link Database.oneOrNone oneOrNone},
         * {@link Database.func func}
         */
        obj.proc = function (procName, values, cb, thisArg) {
            var v = obj.func.call(this, procName, values, $npm.result.one | $npm.result.none);
            return singleValue(v, cb, thisArg);
        };

        /**
         * @method Database.map
         * @description
         * **Added in v.4.3.0**
         *
         * Creates a new array with the results of calling a provided function on every element in the array of rows
         * resolved by method {@link Database.any any}.
         *
         * It is a convenience method to reduce the following code:
         *
         * ```js
         * db.any(query, values)
         *     .then(function(data) {
         *         return data.map(function(row, index, data) {
         *              // return a new element
         *         });
         *     });
         * ```
         *
         * In addition to much shorter code, it offers the following benefits:
         *
         * - Use of a custom iterator has a much better performance than the standard {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map Array.map}
         * - Automatic `this` context through the database protocol
         *
         * @param {String|Object} query
         * Query to be executed, which can any of the following types:
         * - A non-empty query string
         * - Prepared Statement `{name, text, values, ...}` or {@link PreparedStatement} object
         * - Parameterized Query `{text, values, ...}` or {@link ParameterizedQuery} object
         * - {@link QueryFile} object
         *
         * @param {array|value} values
         * Query formatting parameters.
         *
         * When `query` is of type `string` or a {@link QueryFile} object, the `values` can be:
         * - a single value - to replace all `$1` occurrences
         * - an array of values - to replace all `$1`, `$2`, ... variables
         * - an object - to apply $[Named Parameters] formatting
         *
         * When `query` is a Prepared Statement or a Parameterized Query (or their class types),
         * and `values` is not `null` or `undefined`, it is automatically set within such object,
         * as an override for its internal `values`.
         *
         * @param {function} cb
         * Function that produces an element of the new array, taking three arguments:
         * - `row` - the current row being processed in the array
         * - `index` - the index of the current row being processed in the array
         * - `data` - the original array of rows resolved by method {@link Database.any any}
         *
         * @param {} [thisArg]
         * Value to use as `this` when executing the callback.
         *
         * @returns {external:Promise}
         * Resolves with the new array of values returned from the callback.
         *
         * @see
         * {@link Database.any any},
         * {@link Database.each each},
         * {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map Array.map}
         *
         * @example
         *
         * db.map('SELECT id FROM Users WHERE status = $1', ['active'], row => row.id)
         *     .then(data => {
         *         // data = array of active user id-s
         *     })
         *     .catch(error => {
         *        // error
         *     });
         *
         * @example
         *
         * db.tx(t => {
         *     return t.map('SELECT id FROM Users WHERE status = $1', ['active'], row => {
         *        return t.none('UPDATE Events SET checked = $1 WHERE userId = $2', [true, row.id]);
         *     }).then(t.batch);
         * })
         *     .then(data => {
         *         // success
         *     })
         *     .catch(error => {
         *         // error
         *     });
         *
         * @example
         *
         * // Build a list of active users, each with the list of user events:
         * db.task(t => {
         *     return t.map('SELECT id FROM Users WHERE status = $1', ['active'], user => {
         *         return t.any('SELECT * FROM Events WHERE userId = $1', user.id)
         *             .then(events=> {
         *                 user.events = events;
         *                 return user;
         *             });
         *     }).then(t.batch);
         * })
         *     .then(data => {
         *         // success
         *     })
         *     .catch(error => {
         *         // error
         *     });
         *
         */
        obj.map = function (query, values, cb, thisArg) {
            return obj.any.call(this, query, values)
                .then(function (data) {
                    return $arr.map(data, cb, thisArg);
                });
        };

        /**
         * @method Database.each
         * @description
         * **Added in v.4.3.0**
         *
         * Executes a provided function once per array element, for an array of rows resolved by method {@link Database.any any}.
         *
         * It is a convenience method to reduce the following code:
         *
         * ```js
         * db.any(query, values)
         *     .then(function(data) {
         *         data.forEach(function(row, index, data) {
         *              // process the row
         *         });
         *         return data;
         *     });
         * ```
         *
         * In addition to much shorter code, it offers the following benefits:
         *
         * - Use of a custom iterator has a much better performance than the regular {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/forEach Array.forEach}
         * - Automatic `this` context through the database protocol
         *
         * @param {String|Object} query
         * Query to be executed, which can any of the following types:
         * - A non-empty query string
         * - Prepared Statement `{name, text, values, ...}` or {@link PreparedStatement} object
         * - Parameterized Query `{text, values, ...}` or {@link ParameterizedQuery} object
         * - {@link QueryFile} object
         *
         * @param {array|value} [values]
         * Query formatting parameters.
         *
         * When `query` is of type `string` or a {@link QueryFile} object, the `values` can be:
         * - a single value - to replace all `$1` occurrences
         * - an array of values - to replace all `$1`, `$2`, ... variables
         * - an object - to apply $[Named Parameters] formatting
         *
         * When `query` is a Prepared Statement or a Parameterized Query (or their class types),
         * and `values` is not `null` or `undefined`, it is automatically set within such object,
         * as an override for its internal `values`.
         *
         * @param {function} cb
         * Function to execute for each row, taking three arguments:
         * - `row` - the current row being processed in the array
         * - `index` - the index of the current row being processed in the array
         * - `data` - the array of rows resolved by method {@link Database.any any}
         *
         * @param {} [thisArg]
         * Value to use as `this` when executing the callback.
         *
         * @returns {external:Promise}
         * Resolves with the original array of rows.
         *
         * @see
         * {@link Database.any any},
         * {@link Database.map map},
         * {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/forEach Array.forEach}
         *
         * @example
         *
         * db.each('SELECT id, code, name FROM Events', null, row => {
         *     row.code = parseInt(row.code);
         * })
         *     .then(data => {
         *         // data = array of events, with 'code' converted into integer
         *     })
         *     .catch(error => {
         *         // error
         *     });
         *
         */
        obj.each = function (query, values, cb, thisArg) {
            return obj.any.call(this, query, values)
                .then(function (data) {
                    $arr.forEach(data, cb, thisArg);
                    return data;
                });
        };

        /**
         * @method Database.task
         * @description
         * Executes a callback function (or $[ES6 generator]) with an automatically managed connection.
         *
         * This method should be used whenever executing more than one query at once, so the allocated connection
         * is reused between all queries, and released only after the task has finished.
         *
         * The callback function is called with one parameter - database protocol (same as `this`), extended with methods
         * {@link Task.batch batch}, {@link Task.page page}, {@link Task.sequence sequence}, plus property {@link Task.ctx ctx} -
         * the task context object.
         *
         * See class {@link Task} for more details.
         *
         * @param {} tag/cb
         * When the method takes only one parameter, it must be the callback function (or $[ES6 generator]) for the task.
         * However, when calling the method with 2 parameters, the first one is always the `tag` - traceable context for the
         * task (see $[tags]).
         *
         * @param {function|generator} [cb]
         * Task callback function (or $[ES6 generator]), if it is not `undefined`, or else the callback is expected to
         * be passed in as the first parameter.
         *
         * @returns {external:Promise}
         * Result from the callback function.
         *
         * @see
         * {@link Task},
         * {@link Database.tx tx},
         * $[tags]
         *
         * @example
         *
         * // using the regular callback syntax:
         * db.task(function(t) {
         *         // t = this
         *         // t.ctx = task context object
         *
         *         return t.one('SELECT id FROM Users WHERE name = $1', 'John')
         *             .then(user=> {
         *                 return t.any('SELECT * FROM Events WHERE userId = $1', user.id);
         *             });
         *     })
         *     .then(function(data) {
         *         // success
         *         // data = as returned from the task's callback
         *     })
         *     .catch(function(error) {
         *         // error
         *     });
         *
         * @example
         *
         * // using the ES6 arrow syntax:
         * db.task(t=> {
         *         // t.ctx = task context object
         *         
         *         return t.one('SELECT id FROM Users WHERE name = $1', 'John')
         *             .then(user=> {
         *                 return t.any('SELECT * FROM Events WHERE userId = $1', user.id);
         *             });
         *     })
         *     .then(data=> {
         *         // success
         *         // data = as returned from the task's callback
         *     })
         *     .catch(error=> {
         *         // error
         *     });
         *
         * @example
         *
         * // using an ES6 generator for the callback:
         * db.task(function*(t) {
         *         // t = this
         *         // t.ctx = task context object
         *
         *         let user = yield t.one('SELECT id FROM Users WHERE name = $1', 'John');
         *         return yield t.any('SELECT * FROM Events WHERE userId = $1', user.id);
         *     })
         *     .then(function(data) {
         *         // success
         *         // data = as returned from the task's callback
         *     })
         *     .catch(function(error) {
         *         // error
         *     });
         *
         */
        obj.task = function (p1, p2) {
            return taskProcessor.call(this, p1, p2, false);
        };

        /**
         * @method Database.tx
         * @description
         * Executes a callback function (or $[ES6 generator]) as a transaction.
         *
         * A transaction simply wraps a regular {@link Database.task task} in automatic queries:
         * - it executes `BEGIN` just before invoking the callback function
         * - it executes `COMMIT`, if the callback didn't throw any error or return a rejected promise
         * - it executes `ROLLBACK`, if the callback did throw an error or return a rejected promise
         *
         * The callback function is called with one parameter - database protocol (same as `this`), extended with methods
         * {@link Task.batch batch}, {@link Task.page page}, {@link Task.sequence sequence}, plus property {@link Task.ctx ctx} -
         * the transaction context object.
         *
         * See class {@link Task} for more details.
         *
         * Note that transactions should be chosen over tasks only where they are necessary, because unlike regular tasks,
         * transactions are blocking operations, and must be used with caution.
         *
         * @param {} tag/cb
         * When the method takes only one parameter, it must be the callback function (or $[ES6 generator]) for the transaction.
         * However, when calling the method with 2 parameters, the first one is always the `tag` - traceable context for the
         * transaction (see $[tags]).
         *
         * @param {function|generator} [cb]
         * Transaction callback function (or $[ES6 generator]), if it is not `undefined`, or else the callback is expected to be
         * passed in as the first parameter.
         *
         * @returns {external:Promise}
         * Result from the callback function.
         *
         * @see
         * {@link Task},
         * {@link Database.task},
         * $[tags]
         *
         * @example
         *
         * // using the regular callback syntax:
         * db.tx(function(t) {
         *         // t = this
         *         // t.ctx = transaction context object
         *
         *         return t.one('INSERT INTO Users(name, age) VALUES($1, $2) RETURNING id', ['Mike', 25])
         *             .then(user=> {
         *                 return t.none('INSERT INTO Events(userId, name) VALUES($1, $2)', [user.id, 'created']);
         *             });
         *     })
         *     .then(function(data) {
         *         // success
         *         // data = as returned from the transaction's callback
         *     })
         *     .catch(function(error) {
         *         // error
         *     });
         *
         * @example
         *
         * // using the ES6 arrow syntax:
         * db.tx(t=> {
         *         // t.ctx = transaction context object
         *         
         *         return t.one('INSERT INTO Users(name, age) VALUES($1, $2) RETURNING id', ['Mike', 25])
         *             .then(user=> {
         *                 return t.batch([
         *                     t.none('INSERT INTO Events(userId, name) VALUES($1, $2)', [user.id, 'created']),
         *                     t.none('INSERT INTO Events(userId, name) VALUES($1, $2)', [user.id, 'login'])
         *                 ]);
         *             });
         *     })
         *     .then(data=> {
         *         // success
         *         // data = as returned from the transaction's callback
         *     })
         *     .catch(error=> {
         *         // error
         *     });
         *
         * @example
         *
         * // using an ES6 generator for the callback:
         * db.tx(function*(t) {
         *         // t = this
         *         // t.ctx = transaction context object
         *
         *         let user = yield t.one('INSERT INTO Users(name, age) VALUES($1, $2) RETURNING id', ['Mike', 25]);
         *         return yield t.none('INSERT INTO Events(userId, name) VALUES($1, $2)', [user.id, 'created']);
         *     })
         *     .then(function(data) {
         *         // success
         *         // data = as returned from the transaction's callback
         *     })
         *     .catch(function(error) {
         *         // error
         *     });
         *
         */
        obj.tx = function (p1, p2) {
            return taskProcessor.call(this, p1, p2, true);
        };

        // Task method;
        // Resolves with result from the callback function;
        function taskProcessor(p1, p2, isTX) {

            var tag, // tag object/value;
                taskCtx = ctx.clone(); // task context object;

            if (isTX) {
                taskCtx.txLevel = taskCtx.txLevel >= 0 ? (taskCtx.txLevel + 1) : 0;
            }

            if (this !== obj) {
                taskCtx.context = this; // calling context object;
            }

            taskCtx.cb = p1; // callback function;

            // allow inserting a tag in front of the callback
            // function, for better code readability;
            if (p2 !== undefined) {
                tag = p1; // overriding any default tag;
                taskCtx.cb = p2;
            }

            var cb = taskCtx.cb;

            if (typeof cb !== 'function') {
                return $p.reject(new TypeError("Callback function is required for the " + (isTX ? "transaction." : "task.")));
            }

            if (tag === undefined) {
                if (cb.tag !== undefined) {
                    // use the default tag associated with the task:
                    tag = cb.tag;
                } else {
                    if (cb.name) {
                        tag = cb.name; // use the function name as tag;
                    }
                }
            }

            var tsk = new config.$npm.task(taskCtx, tag, isTX, config);

            extend(taskCtx, tsk);

            if (taskCtx.db) {
                // reuse existing connection;
                $npm.utils.addReadProp(tsk.ctx, 'isFresh', taskCtx.db.isFresh);
                return config.$npm.task.exec(taskCtx, tsk, isTX, config);
            }

            // connection required;
            return config.$npm.connect.pool(taskCtx)
                .then(function (db) {
                    taskCtx.connect(db);
                    $npm.utils.addReadProp(tsk.ctx, 'isFresh', db.isFresh);
                    return config.$npm.task.exec(taskCtx, tsk, isTX, config);
                })
                .then(function (data) {
                    taskCtx.disconnect();
                    return data;
                })
                .catch(function (error) {
                    taskCtx.disconnect();
                    return $p.reject(error);
                });
        }

        // lock all default properties to read-only,
        // to prevent override by the client.
        $npm.utils.lock(obj, false, ctx.options);

        // extend the protocol;
        $npm.events.extend(ctx.options, obj, ctx.dc);

        // freeze the protocol permanently;
        $npm.utils.lock(obj, true, ctx.options);
    }

}

var jsHandled, nativeHandled, dbObjects = {};

function checkForDuplicates(cn, config) {
    var cnKey = JSON.stringify(cn);
    if (cnKey in dbObjects) {
        if (!config.options.noWarnings) {
            $npm.con.warn("WARNING: Creating a duplicate database object for the same connection.\n%s\n",
                $npm.utils.getLocalStack(5));
        }
    } else {
        dbObjects[cnKey] = true;
    }
}

function setErrorHandler(config) {
    // we do not do code coverage specific to Native Bindings:
    // istanbul ignore if
    if (config.options.pgNative) {
        if (!nativeHandled) {
            config.pgp.pg.on('error', onError);
            nativeHandled = true;
        }
    } else {
        if (!jsHandled) {
            config.pgp.pg.on('error', onError);
            jsHandled = true;
        }
    }
}

// this event only happens when the connection is lost physically,
// which cannot be tested automatically; removing from coverage:
// istanbul ignore next
function onError(err, client) {
    var ctx = client.$ctx;
    $npm.events.error(ctx.options, err, {
        cn: $npm.utils.getSafeConnection(ctx.cn),
        dc: ctx.dc
    });
}

module.exports = function (config) {
    var npm = config.$npm;
    npm.connect = npm.connect || $npm.connect(config);
    npm.query = npm.query || $npm.query(config);
    npm.task = npm.task || $npm.task(config);
    return Database;
};

/**
 * @callback Database.streamInitCB
 * @description
 * Stream initialization callback, used by {@link Database.stream}.
 *
 * @param {external:Stream} stream
 * Stream object to initialize streaming.
 *
 * @example
 * var QueryStream = require('pg-query-stream');
 * var JSONStream = require('JSONStream');
 *
 * // you can also use pgp.as.format(query, values, options)
 * // to format queries properly, via pg-promise;
 * var qs = new QueryStream('select * from users');
 *
 * db.stream(qs, function (stream) {
 *         // initiate streaming into the console:
 *         stream.pipe(JSONStream.stringify()).pipe(process.stdout);
 *     })
 *     .then(function (data) {
 *         console.log("Total rows processed:", data.processed,
 *           "Duration in milliseconds:", data.duration);
 *     })
 *     .catch(function (error) {
 *         // error;
 *     });
 */

/**
 * @external Stream
 * @see https://nodejs.org/api/stream.html
 */
