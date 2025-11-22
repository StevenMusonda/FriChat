/**
 * Database Configuration and Connection
 * Supports both MySQL and PostgreSQL
 */

const mysql = require('mysql2/promise');
const { Pool } = require('pg');
require('dotenv').config();

const dbType = process.env.DB_TYPE || 'mysql';

let db;

if (dbType === 'mysql') {
    // MySQL Connection Pool
    db = mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 3306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'frichat',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });

    // Test MySQL connection
    (async () => {
        try {
            const connection = await db.getConnection();
            console.log('✓ MySQL Database connected successfully');
            connection.release();
        } catch (error) {
            console.error('✗ MySQL connection failed:', error.message);
        }
    })();

} else if (dbType === 'postgresql') {
    // PostgreSQL Connection Pool
    db = new Pool({
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'frichat',
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
    });

    // Test PostgreSQL connection
    (async () => {
        try {
            const client = await db.connect();
            console.log('✓ PostgreSQL Database connected successfully');
            client.release();
        } catch (error) {
            console.error('✗ PostgreSQL connection failed:', error.message);
        }
    })();
}

/**
 * Execute a query with parameter binding
 * @param {string} query - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Array>} Query results
 */
async function executeQuery(query, params = []) {
    try {
        if (dbType === 'mysql') {
            const [rows] = await db.execute(query, params);
            return rows;
        } else if (dbType === 'postgresql') {
            // Convert MySQL-style ? placeholders to PostgreSQL $1, $2, etc.
            let pgQuery = query;
            let paramIndex = 1;
            pgQuery = pgQuery.replace(/\?/g, () => `$${paramIndex++}`);
            
            const result = await db.query(pgQuery, params);
            return result.rows;
        }
    } catch (error) {
        console.error('Database query error:', error);
        throw error;
    }
}

/**
 * Get a single row from query results
 * @param {string} query - SQL query
 * @param {Array} params - Query parameters
 * @returns {Promise<Object|null>} Single row or null
 */
async function queryOne(query, params = []) {
    const results = await executeQuery(query, params);
    return results.length > 0 ? results[0] : null;
}

module.exports = {
    db,
    executeQuery,
    queryOne,
    dbType
};
