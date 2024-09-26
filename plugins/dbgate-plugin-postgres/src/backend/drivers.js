const _ = require('lodash');
const stream = require('stream');

const driverBases = require('../frontend/drivers');
const Analyser = require('./Analyser');
const pg = require('pg');
const pgCopyStreams = require('pg-copy-streams');
const { getLogger, createBulkInsertStreamBase, makeUniqueColumnNames, extractDbNameFromComposite } =
  global.DBGATE_PACKAGES['dbgate-tools'];

const logger = getLogger('postreDriver');

pg.types.setTypeParser(1082, 'text', val => val); // date
pg.types.setTypeParser(1114, 'text', val => val); // timestamp without timezone
pg.types.setTypeParser(1184, 'text', val => val); // timestamp

function extractPostgresColumns(result) {
  if (!result || !result.fields) return [];
  const res = result.fields.map(fld => ({
    columnName: fld.name,
  }));
  makeUniqueColumnNames(res);
  return res;
}

function zipDataRow(rowArray, columns) {
  return _.zipObject(
    columns.map(x => x.columnName),
    rowArray
  );
}

/** @type {import('dbgate-types').EngineDriver} */
const drivers = driverBases.map(driverBase => ({
  ...driverBase,
  analyserClass: Analyser,

  async connect({
    engine,
    server,
    port,
    user,
    password,
    database,
    databaseUrl,
    useDatabaseUrl,
    ssl,
    isReadOnly,
    authType,
    socketPath,
  }) {
    let options = null;

    if (engine == 'redshift@dbgate-plugin-postgres') {
      let url = databaseUrl;
      if (url && url.startsWith('jdbc:redshift://')) {
        url = url.substring('jdbc:redshift://'.length);
      }
      if (user && password) {
        url = `postgres://${user}:${password}@${url}`;
      } else if (user) {
        url = `postgres://${user}@${url}`;
      } else {
        url = `postgres://${url}`;
      }

      options = {
        connectionString: url,
      };
    } else {
      options = useDatabaseUrl
        ? {
            connectionString: databaseUrl,
            application_name: 'DbGate',
          }
        : {
            host: authType == 'socket' ? socketPath || driverBase.defaultSocketPath : server,
            port: authType == 'socket' ? null : port,
            user,
            password,
            database: extractDbNameFromComposite(database) || 'postgres',
            ssl,
            application_name: 'DbGate',
          };
    }

    const client = new pg.Client(options);
    await client.connect();

    const dbhan = {
      client,
      database,
    };

    if (isReadOnly) {
      await this.query(dbhan, 'SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    }

    return dbhan;
  },
  async close(dbhan) {
    return dbhan.client.end();
  },
  async query(dbhan, sql) {
    if (sql == null) {
      return {
        rows: [],
        columns: [],
      };
    }
    const res = await dbhan.client.query({ text: sql, rowMode: 'array' });
    const columns = extractPostgresColumns(res);
    return { rows: (res.rows || []).map(row => zipDataRow(row, columns)), columns };
  },
  stream(dbhan, sql, options) {
    const query = new pg.Query({
      text: sql,
      rowMode: 'array',
    });

    let wasHeader = false;

    query.on('row', row => {
      if (!wasHeader) {
        columns = extractPostgresColumns(query._result);
        if (columns && columns.length > 0) {
          options.recordset(columns);
        }
        wasHeader = true;
      }

      options.row(zipDataRow(row, columns));
    });

    query.on('end', () => {
      const { command, rowCount } = query._result || {};

      if (command != 'SELECT' && _.isNumber(rowCount)) {
        options.info({
          message: `${rowCount} rows affected`,
          time: new Date(),
          severity: 'info',
        });
      }

      if (!wasHeader) {
        columns = extractPostgresColumns(query._result);
        if (columns && columns.length > 0) {
          options.recordset(columns);
        }
        wasHeader = true;
      }

      options.done();
    });

    query.on('error', error => {
      logger.error({ error }, 'Stream error');
      const { message, position, procName } = error;
      let line = null;
      if (position) {
        line = sql.substring(0, parseInt(position)).replace(/[^\n]/g, '').length;
      }
      options.info({
        message,
        line,
        procedure: procName,
        time: new Date(),
        severity: 'error',
      });
      options.done();
    });

    dbhan.client.query(query);
  },
  async getVersion(dbhan) {
    const { rows } = await this.query(dbhan, 'SELECT version()');
    const { version } = rows[0];

    const isCockroach = version.toLowerCase().includes('cockroachdb');
    const isRedshift = version.toLowerCase().includes('redshift');
    const isPostgres = !isCockroach && !isRedshift;

    const m = version.match(/([\d\.]+)/);
    let versionText = null;
    let versionMajor = null;
    let versionMinor = null;
    if (m) {
      if (isCockroach) versionText = `CockroachDB ${m[1]}`;
      if (isRedshift) versionText = `Redshift ${m[1]}`;
      if (isPostgres) versionText = `PostgreSQL ${m[1]}`;
      const numbers = m[1].split('.');
      if (numbers[0]) versionMajor = parseInt(numbers[0]);
      if (numbers[1]) versionMinor = parseInt(numbers[1]);
    }

    return {
      version,
      versionText,
      isPostgres,
      isCockroach,
      isRedshift,
      versionMajor,
      versionMinor,
    };
  },
  async readQuery(dbhan, sql, structure) {
    const query = new pg.Query({
      text: sql,
      rowMode: 'array',
    });

    let wasHeader = false;
    let columns = null;

    const pass = new stream.PassThrough({
      objectMode: true,
      highWaterMark: 100,
    });

    query.on('row', row => {
      if (!wasHeader) {
        columns = extractPostgresColumns(query._result);
        pass.write({
          __isStreamHeader: true,
          ...(structure || { columns }),
        });
        wasHeader = true;
      }

      pass.write(zipDataRow(row, columns));
    });

    query.on('end', () => {
      if (!wasHeader) {
        columns = extractPostgresColumns(query._result);
        pass.write({
          __isStreamHeader: true,
          ...(structure || { columns }),
        });
        wasHeader = true;
      }

      pass.end();
    });

    query.on('error', error => {
      console.error(error);
      pass.end();
    });

    dbhan.client.query(query);

    return pass;
  },
  async writeTable(dbhan, name, options) {
    // @ts-ignore
    return createBulkInsertStreamBase(this, stream, dbhan, name, options);
  },
  async listDatabases(dbhan) {
    const { rows } = await this.query(dbhan, 'SELECT datname AS name FROM pg_database WHERE datistemplate = false');
    return rows;
  },

  getAuthTypes() {
    return [
      {
        title: 'Host and port',
        name: 'hostPort',
      },
      {
        title: 'Socket',
        name: 'socket',
      },
    ];
  },

  async listSchemas(dbhan) {
    const schemaRows = await this.query(
      dbhan,
      'select oid as "object_id", nspname as "schema_name" from pg_catalog.pg_namespace'
    );
    const defaultSchemaRows = await this.query(dbhan, 'SELECT current_schema');
    const defaultSchema = defaultSchemaRows.rows[0]?.current_schema?.trim();

    logger.debug(`Loaded ${schemaRows.rows.length} postgres schemas`);

    const schemas = schemaRows.rows.map(x => ({
      schemaName: x.schema_name,
      objectId: x.object_id,
      isDefault: x.schema_name == defaultSchema,
    }));

    return schemas;
  },

  writeQueryFromStream(dbhan, sql) {
    const stream = dbhan.client.query(pgCopyStreams.from(sql));
    return stream;
  },
}));

module.exports = drivers;
