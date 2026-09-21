// Loads .env into process.env. Import this before config.ts, which reads
// the variables once at module load.
import dotenv from 'dotenv';
dotenv.config();
