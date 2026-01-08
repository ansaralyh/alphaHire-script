/**
 * Webhook handler for Reachinbox REPLY_RECEIVED events
 * Main business logic for email classification and auto-reply
 */

import { Request, Response } from 'express';
import { incrementLoop, isProcessed, markProcessed, getLastTemplateId, setLastTemplateId, getLoopCount, isUnsubscribed, markAsUnsubscribed, getAutoRepliesSent, incrementAutoRepliesSent, isAgreementSent, markAgreementSent, isManualOwner, markAsManualOwner, resetManualOwner, getLockedRoles, addLockedRole, setLockedRoles, getLastFrom, setLastFrom } from '../state/threadState';
import { fetchThread, getLatestMessage, getMessageText, sendEmail } from '../api/reachinbox';
import { classifyEmail, EmailMeta } from '../api/openai';
import { sendAgreement } from '../api/esign';
import { sendAlert } from '../api/slack';
import { getScript, requiresESignature, AUTO_SEND_TEMPLATES, getFollowUpEmailText } from '../config/scripts';
import { decideAutoRespond, Classification, Signal } from '../src/confidence';

/**
 * Whitelist of template_ids allowed after 2 auto-replies
 * After 2 auto-replies, only allow automation again if the next classification is clearly one of:
 * - YES_SEND: They want the agreement
 * - ASK_AGREEMENT: They explicitly ask for agreement
 * - NOT_HIRING: They say they're not hiring (hard stop - no reply)
 * - NOT_INTERESTED_GENERAL: They're not interested (hard stop - no reply)
 * - UNSUBSCRIBE: They want to unsubscribe (hard stop - no reply)
 * - DONE_ALL_SET: They say "we're all set" (hard stop - no reply)
 * Everything else → manual review + no further email
 * 
 * NOTE: This is now handled by the confidence system (DEPTH_WHITELIST)
 * Kept here for reference only
 */
const ALLOWED_AFTER_FIRST_REPLY = new Set<string>([
  'YES_SEND',
  'ASK_AGREEMENT',
  'NOT_HIRING',
  'NOT_INTERESTED_GENERAL',
  'UNSUBSCRIBE',
  'DONE_ALL_SET',
]);

/**
 * Date when bot marker feature was deployed
 * Only check for manual replies in messages sent after this date
 * Messages before this date don't have bot markers, so we skip the check
 * Set to today's date - all messages from this point forward will work with automation
 */
const BOT_MARKER_FEATURE_DATE = new Date('2025-12-06T00:00:00Z'); // Today's date - automation works from now onward

/**
 * Handle REPLY_RECEIVED webhook from Reachinbox
 * @param req - Express request object
 * @param res - Express response object
 */
export async function handleReachinboxWebhook(req: Request, res: Response): Promise<void> {
  try {
    // Basic sanity check - only handle REPLY_RECEIVED events
    if (req.body.event !== 'REPLY_RECEIVED') {
      console.log(`Ignoring event type: ${req.body.event}`);
      res.status(200).json({ message: 'Event ignored' });
      return;
    }

    // Extract fields from Reachinbox webhook payload
    // Note: Reachinbox sends original_message_id instead of thread_id
    const {
      message_id,
      original_message_id, // This is the thread_id in Reachinbox webhooks
      email_account,
      lead_email,
      lead_first_name,
      lead_last_name,
      email_replied_body,
      email_subject,
    } = req.body;

    // Use original_message_id as thread_id (Reachinbox doesn't send thread_id)
    const thread_id = original_message_id;

    // Combine first and last name if available
    const lead_name = lead_first_name || lead_last_name 
      ? `${lead_first_name || ''} ${lead_last_name || ''}`.trim() 
      : undefined;

    // lead_company is not in Reachinbox webhook, so it will be undefined
    const lead_company = undefined;

    // Validate required fields
    if (!message_id) {
      console.error('Missing required field: message_id');
      res.status(400).json({ error: 'Missing required field: message_id' });
      return;
    }

    // thread_id (original_message_id) is optional - use message_id as fallback if missing
    const effectiveThreadId = thread_id || message_id;

    console.log(`Processing webhook: message_id=${message_id}, thread_id=${effectiveThreadId}`);

    // 2. Get message text early (before duplicate check) - needed for content-based duplicate detection
    let messageText: string = '';
    let latestMessage: any = null;
    let threadSubject: string = 'Your inquiry';
    let threadFrom: string = lead_email || '';

    // Try to use email_replied_body from webhook first (most reliable)
    if (email_replied_body && email_replied_body.trim().length > 0) {
      messageText = email_replied_body.trim();
      console.log(`Using email_replied_body from webhook (length: ${messageText.length})`);
    }

    // Duplicate prevention: Check if message was already processed
    // IMPORTANT: If message_id equals thread_id, Reachinbox is likely reusing the thread_id as message_id for replies
    // This is a Reachinbox bug - we need to handle it by processing these messages anyway
    const messageIdEqualsThreadId = message_id === effectiveThreadId;
    
    if (isProcessed(message_id) && !messageIdEqualsThreadId) {
      // Normal case: message_id is unique and we've seen it before - skip
      console.log(`Message already processed, skipping: ${message_id}`);
      res.status(200).json({ message: 'Message already processed' });
      return;
    }
    
    // If message_id equals thread_id, this is likely a new reply that Reachinbox incorrectly identified
    // Process it anyway (but we'll still mark it as processed at the end to prevent immediate duplicates)
    if (messageIdEqualsThreadId && isProcessed(message_id)) {
      console.log(`Message ID equals thread ID - Reachinbox may be reusing thread_id as message_id for replies. Processing anyway to handle new reply content.`);
    }

    // 1.5. Check if lead is unsubscribed (Do Not Contact) - skip all processing
    if (isUnsubscribed(lead_email)) {
      console.log(`Lead is unsubscribed (DNC), skipping all processing: ${lead_email}`);
      res.status(200).json({ 
        message: 'Lead is unsubscribed - no reply sent',
        lead_email,
      });
      markProcessed(message_id);
      return;
    }

    // 1.6. Check if thread is manually owned (human has taken over) - skip automation
    // Note: We'll check thread history later and reset if it was incorrectly marked (old messages)
    // For now, continue processing - the reset will happen during thread history check

    // Always fetch thread data to get proper threading information (subject, references, etc.)
    let threadData;
    try {
      console.log(`Fetching thread for threading info: ${effectiveThreadId}`);
      if (!email_account) {
        throw new Error('email_account is required to fetch thread');
      }
      threadData = await fetchThread(email_account, effectiveThreadId);
      
      // Extract latest message from thread
      latestMessage = getLatestMessage(threadData);
      if (latestMessage) {
        // Use thread data for subject and from if we don't have email_replied_body
        if (!messageText) {
          messageText = getMessageText(latestMessage);
        }
        // Use email_subject from webhook if available, otherwise use from thread
        threadSubject = email_subject || latestMessage.subject || 'Your inquiry';
        threadFrom = latestMessage.fromEmail || latestMessage.from || lead_email || '';
        
        // Check if last outbound message (from us) was manual (doesn't have bot marker)
        // Look through thread messages to find the last one sent from our email account
        // IMPORTANT: Only check automation REPLIES, not campaign/initial emails
        if (threadData.messages && Array.isArray(threadData.messages)) {
          const botMarker = 'X-Autobot: alphahire-v1';
          const ourEmailAccount = email_account?.toLowerCase();
          
          // Find last outbound message (from our account)
          for (let i = threadData.messages.length - 1; i >= 0; i--) {
            const msg = threadData.messages[i];
            const msgFrom = (msg.fromEmail || msg.from || '').toLowerCase();
            
            // If this message is from our account
            if (ourEmailAccount && msgFrom === ourEmailAccount.toLowerCase()) {
              // Check if this is a campaign email (initial outreach) or an automation reply
              // Campaign emails are the first message in the thread and don't have inReplyTo/references
              // Automation replies are responses to lead emails and have inReplyTo/references
              const isReply = !!(msg.inReplyTo || msg.references || (msg.subject && msg.subject.toLowerCase().startsWith('re:')));
              const isFirstMessage = i === 0; // First message in thread is usually the campaign email
              
              // Skip bot marker check for campaign emails (initial outreach)
              // Only check for bot markers in automation REPLIES
              if (!isReply || isFirstMessage) {
                console.log(`Skipping bot marker check - this appears to be a campaign email (initial outreach), not an automation reply: thread_id=${effectiveThreadId}, isReply=${isReply}, isFirstMessage=${isFirstMessage}`);
                // Campaign emails don't have bot markers, so we skip the check
                // If thread was previously marked as manual owner (false positive), reset it
                if (isManualOwner(effectiveThreadId)) {
                  console.log(`Resetting manual owner flag for thread (was incorrectly marked due to campaign email): thread_id=${effectiveThreadId}`);
                  resetManualOwner(effectiveThreadId);
                }
                // Don't mark as manual - this is a campaign email, not an automation reply
                break;
              }
              
              // Check message date - only check messages sent after bot marker feature was deployed
              const messageDate = msg.timestamp 
                ? new Date(msg.timestamp) 
                : msg.created_at 
                  ? new Date(msg.created_at) 
                  : null;
              
              // If message is old (before bot marker feature), skip the check
              // Old messages don't have markers, so we can't determine if they were manual
              if (messageDate && messageDate < BOT_MARKER_FEATURE_DATE) {
                console.log(`Skipping manual detection for old message (before bot marker feature): ${messageDate.toISOString()}, thread_id=${effectiveThreadId}`);
                // If thread was previously marked as manual owner (false positive), reset it
                if (isManualOwner(effectiveThreadId)) {
                  console.log(`Resetting manual owner flag for thread (was incorrectly marked due to old message): thread_id=${effectiveThreadId}`);
                  resetManualOwner(effectiveThreadId);
                }
                // Don't mark as manual - this is an old message without markers
                break;
              }
              
              // Only check recent automation replies (after bot marker feature) for bot marker
              const msgBody = getMessageText(msg) || msg.body || msg.text || msg.html || '';
              // Check both the marker string and the HTML comment format
              const hasBotMarker = msgBody.includes(botMarker) || 
                                   msgBody.includes('X-Autobot') || 
                                   msgBody.includes('alphahire-v1');
              // If last outbound automation reply doesn't have bot marker, it was manual
              if (!hasBotMarker) {
                console.log(`Manual reply detected in thread history (no bot marker in automation reply), marking as manual owner: thread_id=${effectiveThreadId}`);
                markAsManualOwner(effectiveThreadId);
                res.status(200).json({ 
                  message: 'Manual reply detected - thread marked as manually owned',
                  thread_id: effectiveThreadId,
                });
                markProcessed(message_id);
                return;
              }
              // Found our last automation reply with bot marker (it was auto), stop searching
              break;
            }
          }
        }
      }
    } catch (error: any) {
      console.warn('Failed to fetch thread (non-fatal):', error.message);
      // Don't fail - we'll try to proceed with what we have
      // Removed Slack notification - client wants only agreement sent and manual review alerts
    }

    // 3.4. Check subject line for stop/unsubscribe signals
    const subjectText = email_subject || '';
    const subjectLower = subjectText.toLowerCase();
    if (subjectLower.includes('stop') || subjectLower.includes('unsubscribe') || 
        subjectLower === 'no' || subjectLower.startsWith('no ')) {
      console.log(`Stop/unsubscribe detected in subject line: ${subjectText}`);
      markAsUnsubscribed(lead_email);
      res.status(200).json({
        message: 'Stop/unsubscribe in subject - marked as DNC, no reply sent',
        template_id: 'UNSUBSCRIBE',
      });
      markProcessed(message_id);
      return;
    }

    // 3.5. Check for blank/empty messages - classify as AUTO_REPLY_BLANK
    if (!messageText || messageText.trim().length === 0) {
      console.log(`Blank/empty message detected, treating as AUTO_REPLY_BLANK: message_id=${message_id}`);
      // Treat as blank auto-reply - skip classification and go straight to handler
      res.status(200).json({
        message: 'Blank auto-reply detected - no reply sent',
        template_id: 'AUTO_REPLY_BLANK',
      });
      markProcessed(message_id);
      return;
    }

    // 3.6. Fallback OOO detection (check before classification to catch missed OOO messages)
    const oooPattern = /(out of office|ooo|automatic reply|auto-?reply|vacation|away from the office|i'?m (currently )?out|will return|will respond (upon|when) (my )?return|currently unavailable|i will be away|i am currently out|out until|back on|returning on|away until)/i;
    if (oooPattern.test(messageText)) {
      // Additional check: If sender name matches lead name, it's likely OOO auto-reply
      const senderName = lead_name?.toLowerCase().trim() || '';
      const messageLower = messageText.toLowerCase();
      // Check if message contains sender's name (common in OOO auto-replies)
      if (senderName && messageLower.includes(senderName)) {
        console.log(`OOO pattern detected with sender name match, forcing OUT_OF_OFFICE classification`);
        res.status(200).json({
          message: 'Out of office message (name match detected) - no reply sent',
          template_id: 'OUT_OF_OFFICE',
        });
        markProcessed(message_id);
        return;
      }
      // Also check if email subject/body mentions same email address
      if (lead_email && messageLower.includes(lead_email.toLowerCase())) {
        console.log(`OOO pattern detected with email match, forcing OUT_OF_OFFICE classification`);
        res.status(200).json({
          message: 'Out of office message (email match detected) - no reply sent',
          template_id: 'OUT_OF_OFFICE',
        });
        markProcessed(message_id);
        return;
      }
      console.log('OOO pattern detected in message text, forcing OUT_OF_OFFICE classification');
      res.status(200).json({
        message: 'Out of office message - no reply sent',
        template_id: 'OUT_OF_OFFICE',
      });
      markProcessed(message_id);
      return;
    }

    // 3.7. PRIORITY FIX #11: Check for wrong person with same email BEFORE classification
    // Early detection: Check if message mentions wrong person AND contains same email as sender
    const wrongPersonPattern = /(wrong person|not the right person|not the hiring manager|please contact|reach out to)/i;
    if (wrongPersonPattern.test(messageText)) {
      // Check if message contains an email that matches sender's email
      const emailPattern = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
      const emailsInMessage = messageText.match(emailPattern) || [];
      const senderEmail = threadFrom || lead_email;
      
      // If any email in message matches sender email, it's likely wrong person with same email bug
      if (emailsInMessage.some(email => email.toLowerCase().trim() === senderEmail?.toLowerCase().trim())) {
        console.log(`Wrong person with same email detected early: sender=${senderEmail}, emails_in_message=${emailsInMessage.join(', ')}`);
        res.status(200).json({
          message: 'Wrong person - same email detected (early check), manual review required',
          template_id: 'WRONG_PERSON_NO_CONTACT',
        });
        markProcessed(message_id);
        return;
      }
    }

    // 4. Classify Email with OpenAI
    const meta: EmailMeta = {
      lead_email,
      lead_name,
      lead_company,
    };

    let classification;
    try {
      classification = await classifyEmail(messageText, meta);
    } catch (error: any) {
      console.error('Classification failed:', error);
      // Removed Slack notification - client wants only agreement sent and manual review alerts
      res.status(500).json({ error: 'Classification failed' });
      return;
    }

    // 4.3. SPECIAL HANDLING: INTERESTED template - simple acknowledgment + Slack notification
    // Skip normal flow, send simple email, notify team for manual agreement sending
    if (classification.template_id === 'INTERESTED') {
      console.log(`INTERESTED template detected - sending acknowledgment and Slack notification: thread_id=${effectiveThreadId}`);
      
      // Get simple acknowledgment email template
      const replyText = getScript('INTERESTED', {}, {});
      
      // Send acknowledgment email
      try {
        // Build threading information
        let inReplyTo: string | undefined;
        let references: string[] = [];
        let originalMessageId: string | undefined;

        if (latestMessage) {
          inReplyTo = latestMessage.messageId || latestMessage.id;
          originalMessageId = latestMessage.originalMessageId || effectiveThreadId;
          
          if (latestMessage.references) {
            if (Array.isArray(latestMessage.references)) {
              if (latestMessage.references.length > 0 && typeof latestMessage.references[0] === 'string' && latestMessage.references[0].includes(' ')) {
                references = latestMessage.references[0].split(' ').filter((ref: string) => ref.trim().length > 0);
              } else {
                references = latestMessage.references.filter((ref: any) => typeof ref === 'string' && ref.trim().length > 0);
              }
            } else if (typeof latestMessage.references === 'string') {
              references = latestMessage.references.split(' ').filter((ref: string) => ref.trim().length > 0);
            }
          }
          
          if (inReplyTo && !references.includes(inReplyTo)) {
            references.push(inReplyTo);
          }
        } else {
          inReplyTo = message_id;
          originalMessageId = effectiveThreadId;
          references = message_id ? [message_id] : [];
          if (effectiveThreadId && !references.includes(effectiveThreadId)) {
            references.unshift(effectiveThreadId);
          }
        }

        if (!email_account) {
          throw new Error('email_account is required to send email');
        }

        const toEmail = lead_email || threadFrom;
        if (!toEmail || !toEmail.trim()) {
          throw new Error('Recipient email address is required for sending the reply');
        }

        // Add bot marker to email body
        const botMarker = '\n\n<!-- X-Autobot: alphahire-v1 -->';
        const replyTextWithMarker = replyText + botMarker;

        await sendEmail({
          from: email_account,
          to: toEmail,
          subject: threadSubject.startsWith('Re:') ? threadSubject : `Re: ${threadSubject}`,
          body: replyTextWithMarker,
          inReplyTo: inReplyTo,
          references: references,
          originalMessageId: originalMessageId,
        });
        console.log(`INTERESTED acknowledgment sent successfully: thread_id=${effectiveThreadId}`);
        
        // Increment auto-replies sent counter
        incrementAutoRepliesSent(effectiveThreadId);
        setLastTemplateId(effectiveThreadId, 'INTERESTED');
      } catch (error: any) {
        console.error('Failed to send INTERESTED acknowledgment:', error);
        res.status(500).json({ error: 'Failed to send acknowledgment' });
        return;
      }

      // Send Slack notification: "Agreement requested"
      await sendAlert(`📋 Agreement requested`, {
        event: 'agreement_requested',
        thread_id: effectiveThreadId,
        message_id,
        lead_email,
        lead_name,
        lead_company,
        template_id: 'INTERESTED',
      });

      // Mark message as processed and return
      markProcessed(message_id);
      res.status(200).json({
        message: 'INTERESTED - acknowledgment sent, agreement requested notification sent to Slack',
        template_id: 'INTERESTED',
        agreement_requested: true,
      });
      return;
    }

    // 4.3. Convert classification to confidence system format
    const classificationForConfidence: Classification = {
      template_id: classification.template_id,
      signals: classification.signals as Signal[],
      extracted: classification.extracted || {},
    };

    // 4.4. Extract and lock roles when clearly stated
    const extracted = classification.extracted || {};
    if (extracted.role) {
      addLockedRole(effectiveThreadId, extracted.role);
      console.log(`Role locked: ${extracted.role} for thread ${effectiveThreadId}`);
    }

    // 4.5. Track active contact (last sender) - update on every inbound message
    // Use threadFrom (sender email) or lead_email as fallback
    const senderEmail = threadFrom || lead_email;
    if (senderEmail) {
      setLastFrom(effectiveThreadId, senderEmail);
      console.log(`Active contact updated: ${senderEmail} for thread ${effectiveThreadId}`);
    }

    // 4.6. Build thread state for confidence system
    const currentAutoReplies = getAutoRepliesSent(effectiveThreadId);
    const processedMessageIds = new Set<string>();
    if (isProcessed(message_id)) {
      processedMessageIds.add(message_id);
    }

    const threadState = {
      autoRepliesSent: currentAutoReplies,
      agreementSent: isAgreementSent(effectiveThreadId),
      manualOwner: isManualOwner(effectiveThreadId),
      lastTemplateSent: getLastTemplateId(effectiveThreadId) || undefined,
      processedMessageIds: processedMessageIds.size > 0 ? processedMessageIds : undefined,
    };

    // 4.7. Use confidence system to decide if we should auto-respond
    let decision = decideAutoRespond({
      classification: classificationForConfidence,
      bodyText: messageText,
      threadState,
      messageId: message_id,
      confidenceThreshold: 0.90, // Default threshold
    });

    let template_id = decision.effectiveTemplateId; // Use let since we may modify it later

    // 4.8. Handle hard stops (UNSUBSCRIBE, OUT_OF_OFFICE, AUTO_REPLY_BLANK, DONE_ALL_SET)
    if (template_id === 'UNSUBSCRIBE') {
      console.log(`Unsubscribe detected, marking as DNC and skipping reply: message_id=${message_id}, lead_email=${lead_email}`);
      if (lead_email) {
        markAsUnsubscribed(lead_email);
      }
      res.status(200).json({
        message: 'Unsubscribe detected - lead marked as DNC, no reply sent',
        template_id,
        lead_email,
      });
      markProcessed(message_id);
      return;
    }

    if (template_id === 'OUT_OF_OFFICE') {
      console.log(`Out of office detected, skipping reply: message_id=${message_id}`);
      res.status(200).json({
        message: 'Out of office detected - no reply sent',
        template_id,
      });
      markProcessed(message_id);
      return;
    }

    if (template_id === 'AUTO_REPLY_BLANK') {
      console.log(`Blank auto-reply detected, skipping reply: message_id=${message_id}`);
      res.status(200).json({
        message: 'Blank auto-reply detected - no reply sent',
        template_id,
      });
      markProcessed(message_id);
      return;
    }

    if (template_id === 'DONE_ALL_SET') {
      console.log(`Done/all set detected, skipping reply: message_id=${message_id}`);
      res.status(200).json({
        message: 'Done/all set detected - no reply sent',
        template_id,
      });
      markProcessed(message_id);
      return;
    }

    // 4.9. If confidence decision says NO, stop silently (no Slack alerts)
    // NOTE: Client request - only send Slack notification for "agreement requested"
    if (!decision.okToAutoRespond && template_id !== 'INTERESTED') {
      console.log(`Confidence check failed: confidence=${decision.confidence.toFixed(2)}, blocking reasons: ${decision.blockingReasons.join(', ')}`);
      // Slack manual review alerts are disabled - client wants only "agreement requested" notifications
      res.status(200).json({
        message: 'Manual review required - confidence below threshold',
        template_id,
        confidence: decision.confidence,
        blocking_reasons: decision.blockingReasons,
      });
      markProcessed(message_id);
      return;
    }

    // 4.10. Confidence check passed - proceed with auto-response
    console.log(`Confidence check passed: confidence=${decision.confidence.toFixed(2)}, template_id=${template_id}`);

    // 4.6. Handle WRONG_PERSON_NO_CONTACT - Do not send reply, alert for manual review
    if (template_id === 'WRONG_PERSON_NO_CONTACT') {
      console.log(`Wrong person, no contact provided, skipping reply: message_id=${message_id}`);
      // Commented out - client wants only "agreement requested" notifications in Slack
      // await sendAlert(`⚠️ Manual Review Required: Wrong person, no contact provided`, {
      //   event: 'manual_review',
      //   thread_id: effectiveThreadId,
      //   message_id,
      //   lead_email,
      //   lead_name,
      //   lead_company,
      //   template_id,
      //   reason: 'Wrong person - no contact information provided',
      // });
      res.status(200).json({
        message: 'Wrong person, no contact - manual review required',
        template_id,
        reason: 'No contact information provided',
      });
      markProcessed(message_id);
      return;
    }

    // 4.11. Validate WRONG_PERSON_WITH_CONTACT - ensure contact_email is different from lead_email AND sender_email
    if (template_id === 'WRONG_PERSON_WITH_CONTACT') {
      const contactEmail = extracted.new_contact_email;
      const senderEmail = threadFrom || lead_email;
      
      // Normalize emails for comparison
      const normalizedContactEmail = contactEmail?.toLowerCase().trim();
      const normalizedLeadEmail = lead_email?.toLowerCase().trim();
      const normalizedSenderEmail = senderEmail?.toLowerCase().trim();
      
      // Reject if contact_email is same as lead_email OR sender_email
      if (!contactEmail || 
          normalizedContactEmail === normalizedLeadEmail || 
          normalizedContactEmail === normalizedSenderEmail) {
        // Same email bug detected - this should have been caught by confidence system, but double-check
        console.log(`Same email bug detected: contact_email=${contactEmail}, lead_email=${lead_email}, sender_email=${senderEmail}`);
        // Slack manual review alerts are disabled - client wants only "agreement requested" notifications
        res.status(200).json({
          message: 'Wrong person - same email detected, manual review required',
          template_id: 'WRONG_PERSON_NO_CONTACT',
        });
        markProcessed(message_id);
        return;
      }
    }

    // 4.12. PRIORITY FIX #43: Check if roles are locked and prevent role guessing
    // If roles are locked, use ROLE_CONFIRMED_FOLLOWUP instead of templates that guess roles
    const lockedRolesList = getLockedRoles(effectiveThreadId);
    if (lockedRolesList.length > 0) {
      // If template is one that guesses roles, replace it with ROLE_CONFIRMED_FOLLOWUP
      const roleGuessingTemplates = ['NO_JOB_POST', 'ROLE_UNCLEAR', 'ASKING_WHICH_ROLE'];
      if (roleGuessingTemplates.includes(template_id)) {
        console.log(`Roles are locked (${lockedRolesList.join(', ')}), using ROLE_CONFIRMED_FOLLOWUP instead of ${template_id}`);
        template_id = 'ROLE_CONFIRMED_FOLLOWUP';
        // Update extracted to include locked roles (as string for template)
        extracted.locked_roles = lockedRolesList.join(' and ');
        extracted.role = lockedRolesList[0]; // Use first locked role as primary
        // Update classification for confidence system
        classificationForConfidence.template_id = 'ROLE_CONFIRMED_FOLLOWUP';
        classificationForConfidence.extracted = extracted;
        // Re-run confidence decision with corrected template
        decision = decideAutoRespond({
          classification: classificationForConfidence,
          bodyText: messageText,
          threadState: {
            autoRepliesSent: getAutoRepliesSent(effectiveThreadId),
            agreementSent: isAgreementSent(effectiveThreadId),
            manualOwner: isManualOwner(effectiveThreadId),
            lastTemplateSent: getLastTemplateId(effectiveThreadId) || undefined,
            processedMessageIds: undefined,
          },
          messageId: message_id,
        });
        
        // If corrected decision blocks, respect it
        if (!decision.okToAutoRespond) {
          console.log(`Corrected template ROLE_CONFIRMED_FOLLOWUP blocked: ${decision.blockingReasons.join(', ')}`);
          // Continue with blocked decision - will be handled by existing blocking logic
        }
      }
    }

    // 5. Generate Reply Script
    let replyText;
    try {
      // Convert extracted to vars format for template compatibility
      const vars: any = {
        role: extracted.role || undefined,
        location: extracted.location || undefined,
        role1: extracted.role1 || undefined,
        role2: extracted.role2 || undefined,
        company_name: extracted.company_name || undefined,
        contact_email: extracted.new_contact_email || undefined,
        contact_name: extracted.contact_name || undefined,
        locked_roles: extracted.locked_roles || undefined,
      };
      
      // Check if contact_info_provided signal exists
      const hasContactInfo = decision.normalizedSignals.includes('wrong_person' as Signal) && extracted.new_contact_email;
      const templateFlags = {
        unsubscribe: decision.normalizedSignals.includes('unsubscribe' as Signal),
        contact_info_provided: !!hasContactInfo, // Ensure boolean
      };
      replyText = getScript(template_id, vars, templateFlags);
    } catch (error: any) {
      console.error('Failed to get script:', error);
      // Removed Slack notification - client wants only agreement sent and manual review alerts
      res.status(500).json({ error: 'Failed to generate reply script' });
      return;
    }

    // 11. Send Reply via Reachinbox
    try {
      // Build threading information
      let inReplyTo: string | undefined;
      let references: string[] = [];
      let originalMessageId: string | undefined;

      if (latestMessage) {
        // Use the current message_id as inReplyTo (we're replying to this message)
        inReplyTo = latestMessage.messageId || latestMessage.id;
        
        // originalMessageId should be the first message in the thread
        // Use effectiveThreadId (which is original_message_id from webhook) as the original message ID
        originalMessageId = latestMessage.originalMessageId || effectiveThreadId;
        
        // Build references array from message
        if (latestMessage.references) {
          // references might be a string or array
          if (Array.isArray(latestMessage.references)) {
            // If it's an array, check if first element is a space-separated string
            if (latestMessage.references.length > 0 && typeof latestMessage.references[0] === 'string' && latestMessage.references[0].includes(' ')) {
              // Split space-separated string into array
              references = latestMessage.references[0].split(' ').filter((ref: string) => ref.trim().length > 0);
            } else {
              references = latestMessage.references;
            }
          } else if (typeof latestMessage.references === 'string') {
            // If it's a string, split by spaces if it contains multiple IDs
            if (latestMessage.references.includes(' ')) {
              references = latestMessage.references.split(' ').filter((ref: string) => ref.trim().length > 0);
            } else {
              references = [latestMessage.references];
            }
          }
        }
        
        // Add originalMessageId to references if not already there
        if (originalMessageId && !references.includes(originalMessageId)) {
          references.push(originalMessageId);
        }
        
        // Add inReplyTo to references if not already there
        if (inReplyTo && !references.includes(inReplyTo)) {
          references.push(inReplyTo);
        }
      } else {
        // Fallback: use effectiveThreadId as originalMessageId and message_id as inReplyTo
        inReplyTo = message_id;
        originalMessageId = effectiveThreadId; // effectiveThreadId is the original message ID
        references = message_id ? [message_id] : [];
        if (effectiveThreadId && !references.includes(effectiveThreadId)) {
          references.unshift(effectiveThreadId); // Add thread_id at the beginning
        }
      }

      if (!email_account) {
        throw new Error('email_account is required to send email');
      }

      // Validate the recipient email before calling sendEmail
      const toEmail = lead_email || threadFrom;
      if (!toEmail || !toEmail.trim()) {
        throw new Error('Recipient email address is required for sending the reply');
      }

      // Add bot marker to email body to identify auto-replies
      const botMarker = '\n\n<!-- X-Autobot: alphahire-v1 -->';
      const replyTextWithMarker = replyText + botMarker;

      await sendEmail({
        from: email_account, // Required: sender's email address
        to: toEmail, // Use the validated recipient
        subject: threadSubject.startsWith('Re:') ? threadSubject : `Re: ${threadSubject}`,
        body: replyTextWithMarker,
        inReplyTo: inReplyTo,
        references: references,
        originalMessageId: originalMessageId,
      });
      console.log(`Reply sent successfully: template_id=${template_id}, thread_id=${effectiveThreadId}`);
      
      // Increment auto-replies sent counter for this thread
      incrementAutoRepliesSent(effectiveThreadId);
    } catch (error: any) {
      console.error('Failed to send reply:', error);
      // Removed Slack notification - client wants only agreement sent and manual review alerts
      res.status(500).json({ error: 'Failed to send reply' });
      return;
    }

    // 12. Send E-Signature if Required (with guardrails)
    // PRIORITY: Send agreements at any cost - only block if explicitly already sent
    // EXCEPTION: INTERESTED template is handled separately above - never send agreement here
    if (AUTO_SEND_TEMPLATES.has(template_id) && template_id !== 'INTERESTED') {
      // Check if agreement was already sent for this thread - but allow if they explicitly ask again
      const explicitlyAskingAgain = decision.normalizedSignals.includes('send_agreement' as Signal) || 
                                     decision.normalizedSignals.includes('asks_for_agreement' as Signal) ||
                                     decision.normalizedSignals.includes('send_it' as Signal);
      
      // PRIORITY: Check if this is a reply to our follow-up email (prevent duplicate agreement)
      // If message is very short and just acknowledges the follow-up, don't send agreement again
      const isShortAcknowledgment = messageText.trim().length < 50 && 
                                    (messageText.toLowerCase().includes('thanks') || 
                                     messageText.toLowerCase().includes('thank you') ||
                                     messageText.toLowerCase().includes('received') ||
                                     messageText.toLowerCase().includes('got it'));
      
      // PRIORITY FIX #16: Atomic check to prevent race conditions - check once and use result
      const wasAlreadySent = isAgreementSent(effectiveThreadId);
      
      if (wasAlreadySent && !explicitlyAskingAgain) {
        // If it's a short acknowledgment of follow-up, definitely don't send agreement again
        if (isShortAcknowledgment) {
          console.log(`Agreement already sent and lead just acknowledging follow-up, skipping duplicate send: thread_id=${effectiveThreadId}`);
          // Don't send again - exit early to prevent any processing
          res.status(200).json({
            message: 'Agreement already sent - acknowledgment received, no duplicate send',
            template_id,
            agreement_sent: false,
          });
          markProcessed(message_id);
          return;
        } else {
          console.log(`Agreement already sent for thread ${effectiveThreadId}, skipping duplicate send`);
          // Don't send again, but continue with the rest of the flow
        }
      }
      // If they explicitly ask again, allow it (maybe they didn't receive it)
      else if (wasAlreadySent && explicitlyAskingAgain && !isShortAcknowledgment) {
        console.log(`Agreement already sent but lead explicitly asking again, allowing resend: thread_id=${effectiveThreadId}`);
        // Continue to send agreement below
      }
      // If agreement sent and it's just acknowledgment, skip
      else if (wasAlreadySent && isShortAcknowledgment) {
        console.log(`Agreement already sent and lead just acknowledging, skipping: thread_id=${effectiveThreadId}`);
        // Don't send again - exit early
        res.status(200).json({
          message: 'Agreement already sent - acknowledgment received, no duplicate send',
          template_id,
          agreement_sent: false,
        });
        markProcessed(message_id);
        return;
      }
      // Check for blocking signals - PRIORITY: Send agreements at any cost
      // Only block if they want resume/call first AND not explicitly asking for agreement
      const explicitlyAskingForAgreement = decision.normalizedSignals.includes('send_agreement' as Signal) || 
                                           decision.normalizedSignals.includes('asks_for_agreement' as Signal) ||
                                           decision.normalizedSignals.includes('send_it' as Signal) ||
                                           template_id === 'YES_SEND' || template_id === 'ASK_AGREEMENT';
      
      if (decision.normalizedSignals.includes('wants_resume_first' as Signal) && !explicitlyAskingForAgreement) {
        console.log(`Lead wants resume first, skipping agreement send: template_id=${template_id}, thread_id=${effectiveThreadId}`);
        // Don't send agreement - just send the email reply without agreement
        // Continue to send email reply but skip agreement
      }
      else if (decision.normalizedSignals.includes('wants_call_first' as Signal)) {
        console.log(`Lead wants call first, skipping agreement send: template_id=${template_id}, thread_id=${effectiveThreadId}`);
        // Don't send agreement - just send the email reply without agreement
        // Continue to send email reply but skip agreement
      }
      else if (decision.normalizedSignals.includes('auto_reply_blank' as Signal)) {
        console.log(`Blank auto-reply detected, skipping agreement send: template_id=${template_id}, thread_id=${effectiveThreadId}`);
        // Don't send agreement for blank replies
        // This should have been caught earlier, but double-check
      }
      else if (decision.normalizedSignals.includes('done_all_set' as Signal)) {
        console.log(`Lead said "all set", skipping agreement send: template_id=${template_id}, thread_id=${effectiveThreadId}`);
        // Don't send agreement - they're done
        // This should have been caught earlier, but double-check
      }
      else if (decision.normalizedSignals.includes('already_signed' as Signal)) {
        console.log(`Lead already signed agreement, skipping duplicate send: template_id=${template_id}, thread_id=${effectiveThreadId}`);
        // Mark as sent to prevent future sends
        markAgreementSent(effectiveThreadId);
        // Don't send agreement again - return early to prevent any reply
        res.status(200).json({
          message: 'Lead already signed - no agreement sent',
          template_id,
          agreement_sent: false,
        });
        markProcessed(message_id);
        return;
      }
      // All checks passed - send agreement
      else {
        try {
          // PRIORITY FIX: Use lead_email as primary recipient (the actual lead)
          // getLastFrom() tracks inbound message senders (should be the lead)
          // threadFrom might be the sender's email (person sending the mail), not the lead's email
          // Priority: getLastFrom() (tracked lead) > lead_email (webhook lead) > threadFrom (only if not sender's email)
          const lastFromEmail = getLastFrom(effectiveThreadId);
          
          // CRITICAL: Never use email_account (sender's email) as recipient
          // If threadFrom equals email_account, it's the sender, not the lead - don't use it
          const safeThreadFrom = threadFrom && threadFrom !== email_account ? threadFrom : null;
          
          const recipientEmail = lastFromEmail || lead_email || safeThreadFrom || '';
          
          // Log recipient selection for debugging
          console.log(`Agreement recipient selected: recipient=${recipientEmail}, lead_email=${lead_email}, lastFrom=${lastFromEmail}, threadFrom=${threadFrom}, email_account=${email_account}`);
          
          // Validation: Warn if recipient equals sender's email (this should never happen)
          if (recipientEmail === email_account) {
            console.error(`❌ ERROR: Agreement recipient is sender's email! Using lead_email instead. recipient=${recipientEmail}, lead_email=${lead_email}`);
            // Force use lead_email if recipient is sender's email
            const correctedRecipient = lead_email || '';
            if (correctedRecipient) {
              console.log(`Corrected recipient to lead_email: ${correctedRecipient}`);
            }
          }
          
          // Final recipient (use corrected if needed)
          const finalRecipientEmail = recipientEmail === email_account ? (lead_email || lastFromEmail || '') : recipientEmail;
          
        await sendAgreement({
            clientEmail: finalRecipientEmail,
          clientName: lead_name,
          companyName: lead_company,
        });
        console.log(`Agreement sent successfully: template_id=${template_id}, thread_id=${effectiveThreadId}`);
          
          // Mark agreement as sent IMMEDIATELY after successful send (before any other processing)
          // This ensures the hard stop in confidence system will work for subsequent messages
          markAgreementSent(effectiveThreadId);
        
          // Send follow-up email after agreement is sent (for YES_SEND and ASK_AGREEMENT)
          if (template_id === 'YES_SEND' || template_id === 'ASK_AGREEMENT') {
            try {
            const followUpText = getFollowUpEmailText();
            
            // Build threading information for follow-up email (same as main reply)
            let followUpInReplyTo: string | undefined;
            let followUpReferences: string[] = [];
            let followUpOriginalMessageId: string | undefined;

            if (latestMessage) {
              followUpInReplyTo = latestMessage.messageId || latestMessage.id;
              followUpOriginalMessageId = latestMessage.originalMessageId || effectiveThreadId;
              
              if (latestMessage.references) {
                if (Array.isArray(latestMessage.references)) {
                  if (latestMessage.references.length > 0 && typeof latestMessage.references[0] === 'string' && latestMessage.references[0].includes(' ')) {
                    followUpReferences = latestMessage.references[0].split(' ').filter((ref: string) => ref.trim().length > 0);
                  } else {
                    followUpReferences = latestMessage.references;
                  }
                } else if (typeof latestMessage.references === 'string') {
                  if (latestMessage.references.includes(' ')) {
                    followUpReferences = latestMessage.references.split(' ').filter((ref: string) => ref.trim().length > 0);
                  } else {
                    followUpReferences = [latestMessage.references];
                  }
                }
              }
              
              if (followUpOriginalMessageId && !followUpReferences.includes(followUpOriginalMessageId)) {
                followUpReferences.push(followUpOriginalMessageId);
              }
              
              if (followUpInReplyTo && !followUpReferences.includes(followUpInReplyTo)) {
                followUpReferences.push(followUpInReplyTo);
              }
            } else {
              followUpInReplyTo = message_id;
              followUpOriginalMessageId = effectiveThreadId;
              followUpReferences = message_id ? [message_id] : [];
              if (effectiveThreadId && !followUpReferences.includes(effectiveThreadId)) {
                followUpReferences.unshift(effectiveThreadId);
              }
            }
            
            const toEmail = lead_email || threadFrom;
            if (toEmail && email_account) {
              // Add bot marker to follow-up email body
              const botMarker = '\n\n<!-- X-Autobot: alphahire-v1 -->';
              const followUpTextWithMarker = followUpText + botMarker;
              
              await sendEmail({
                from: email_account,
                to: toEmail,
                subject: threadSubject.startsWith('Re:') ? threadSubject : `Re: ${threadSubject}`,
                body: followUpTextWithMarker,
                inReplyTo: followUpInReplyTo,
                references: followUpReferences,
                originalMessageId: followUpOriginalMessageId,
              });
              console.log(`Follow-up email sent successfully after agreement: template_id=${template_id}, thread_id=${effectiveThreadId}`);
            }
            } catch (error: any) {
              console.error('Failed to send follow-up email:', error);
              // Don't fail the whole request if follow-up email fails, just log
            }
          }
      } catch (error: any) {
        console.error('Failed to send agreement:', error);
          // Removed Slack notification - client wants only agreement sent (success) and manual review alerts
          // Don't fail the whole request if e-sign fails, just log
        }
      }
    }

    // 13. Store last template_id for this thread (for repeat detection)
    setLastTemplateId(effectiveThreadId, template_id);

    // 14. Mark message as processed (only after successful completion)
    markProcessed(message_id);

    // 15. Success Response
    res.status(200).json({
      message: 'Webhook processed successfully',
      template_id,
      reply_sent: true,
      agreement_sent: requiresESignature(template_id),
    });
  } catch (error: any) {
    console.error('Unexpected error in webhook handler:', error);
    // Removed Slack notification - client wants only agreement sent and manual review alerts
    res.status(500).json({ error: 'Internal server error' });
  }
}

