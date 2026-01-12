/**
 * Main Express server entry point
 * Handles webhook endpoint: POST /webhooks/reachinbox
 * Orchestrates the email classification and response flow
 */

import express, { Request, Response, NextFunction } from 'express';
import { getStateStats } from './state/threadState';
import { config } from './config/env';
import { handleReachinboxWebhook } from './handlers/webhookHandler';
// Signwell webhook disabled - import removed
// import { handleSignWellWebhook } from './handlers/signwellWebhookHandler';

// Initialize Express app
const app = express();

// Middleware
app.use(express.json()); // Parse JSON request bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies

// Request logging middleware (optional, for debugging)
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Basic error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
  });
});


// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
    const stats = getStateStats();
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
      stats: {
        processedMessages: stats.processedCount,
        activeThreads: stats.activeThreads,
      },
    });
  });

// Webhook endpoints
app.post('/webhooks/reachinbox', handleReachinboxWebhook);
// Signwell webhook disabled - route removed
// app.post('/webhooks/signwell', handleSignWellWebhook);

// 404 handler for undefined routes
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
const PORT = config.port;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`✅ Ready to receive webhooks:`);
  console.log(`   - Reachinbox: http://localhost:${PORT}/webhooks/reachinbox`);
  // Signwell webhook disabled
  // console.log(`   - SignWell: http://localhost:${PORT}/webhooks/signwell`);
});