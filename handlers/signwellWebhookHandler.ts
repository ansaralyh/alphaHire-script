/**
 * Webhook handler for SignWell events
 * Handles document signing events (document.signed, document.completed, etc.)
 */

import { Request, Response } from 'express';

/**
 * Handle SignWell webhook events
 * DISABLED: Signwell has been completely disabled per client request.
 * This handler is no longer registered as a route endpoint.
 * @param req - Express request object
 * @param res - Express response object
 */
export async function handleSignWellWebhook(req: Request, res: Response): Promise<void> {
  // Signwell webhook is disabled - return immediately
  console.log('SignWell webhook received but Signwell is disabled - ignoring request');
  res.status(200).json({ 
    message: 'Signwell webhook is disabled',
    note: 'Signwell integration has been completely disabled. No agreements are being sent.',
  });
}

