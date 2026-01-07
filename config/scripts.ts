/**
 * Response template scripts configuration
 * Contains all 13 predefined response templates matching OpenAI classification
 */

/**
 * Interface for template variables
 */
export interface TemplateVars {
  role?: string;
  location?: string;
  role1?: string;
  role2?: string;
  company_name?: string;
  contact_email?: string;
  contact_name?: string;
  website_url?: string;
  locked_roles?: string;
  [key: string]: string | undefined;
}

export interface TemplateFlags {
  unsubscribe?: boolean;
  contact_info_provided?: boolean;
}

/**
 * Template function type
 */
type TemplateFunction = (vars: TemplateVars, flags?: TemplateFlags) => string;

/**
 * Template scripts object - maps template_id to script function
 */
export const TPL: Record<string, TemplateFunction> = {
  /**
   * 1. INTERESTED - When They're Interested
   * Simple acknowledgment - team will manually send agreement
   */
  INTERESTED: (vars: TemplateVars) => {
    return `Thank you for your interest! We'll send the agreement shortly.`;
  },

  /**
   * 2. YES_SEND - When They Say "Yes," "Sure," "Send," etc.
   */
  YES_SEND: (vars: TemplateVars) => {
    return `Perfect — I've sent the agreement over now for e-signature.

Once that's in place, we'll be able to share full candidate details without redactions and keep things moving quickly.

If anyone else (HR, hiring manager, or a co-founder) needs to be looped in for future updates, feel free to reply here and I'll include them.`;
  },

  /**
   * 3. NO_JOB_POST - When There's No Job Post
   */
  NO_JOB_POST: (vars: TemplateVars) => {
    // Use explicit role guesses with bullet points - avoid "the role and similar positions"
    const role1 = vars.role1;
    const role2 = vars.role2;
    
    // If we have both role guesses, use bullet format
    if (role1 && role2) {
      return `Thanks for the reply — sounds like we may have crossed wires.

We're happy to send strong candidates for review — no pressure.

Our terms are a simple 10% fee with a 6-month guarantee.

Based on companies like yours, two common roles we support are:

• ${role1}

• ${role2}

Are those correct? If so, I can send the agreement over.`;
    }
    
    // If we only have one role guess
    if (role1) {
      return `Thanks for the reply — sounds like we may have crossed wires.

We're happy to send strong candidates for review — no pressure.

Our terms are a simple 10% fee with a 6-month guarantee.

Based on companies like yours, a common role we support is ${role1}.

Is that correct? If so, I can send the agreement over.`;
    }
    
    // Fallback if no role guesses provided
    return `Thanks for the reply — sounds like we may have crossed wires.

We're happy to send strong candidates for review — no pressure.

Our terms are a simple 10% fee with a 6-month guarantee.

What roles are you typically hiring for? Once I know, I can send the agreement over.`;
  },

  /**
   * 4a. NOT_HIRING - When They Say They're Not Hiring
   */
  NOT_HIRING: (vars: TemplateVars, flags?: TemplateFlags) => {
    const baseMessage = `Totally understand — and appreciate the quick response.`;

    // If unsubscribe flag is true (e.g., "out of business"), don't ask for agreement
    if (flags?.unsubscribe) {
      return `${baseMessage}

Thanks for letting me know — I won't reach out again.`;
    }

    return `${baseMessage}

If that changes or you reopen hiring later, we'd love to help on tough roles under our 10% / 6-month guarantee model.

Would you like me to send the agreement so you have it on file for when you're ready?`;
  },

  /**
   * 4b. NOT_INTERESTED_GENERAL - When They're Not Interested (General)
   */
  NOT_INTERESTED_GENERAL: (vars: TemplateVars, flags?: TemplateFlags) => {
    const baseMessage = `Totally understand — and appreciate the quick response.`;

    // If unsubscribe flag is true (e.g., "out of business"), don't ask for agreement
    if (flags?.unsubscribe) {
      return `${baseMessage}

Thanks for letting me know — I won't reach out again.`;
    }

    return `${baseMessage}

If hiring needs shift or a tough role comes up, we're here to help under our 10% / 6-month guarantee model.

Would you like me to send the agreement so you have it on file for future roles?`;
  },

  /**
   * 5. UNSUBSCRIBE - When They Want to Unsubscribe
   * NOTE: This template is NOT used - handler skips reply and marks lead as DNC
   * Kept here for reference only
   */
  UNSUBSCRIBE: (vars: TemplateVars) => {
    // This template is never called - handler returns early for UNSUBSCRIBE
    return `Thanks for letting me know — I won't reach out again.

Before I close this out, would you like me to send our agreement for future reference in case a hard-to-fill role comes up?`;
  },

  /**
   * 6. ASK_AGREEMENT - When They Ask for the Agreement
   */
  ASK_AGREEMENT: (vars: TemplateVars) => {
    return `Absolutely — I've just sent the agreement to this email for e-signature.

If anyone else needs to be included (HR, hiring manager, co-founder), feel free to reply here and I'll add them to future communication.`;
  },

  /**
   * 7. TOO_EXPENSIVE - When They Say It's Too Expensive
   */
  TOO_EXPENSIVE: (vars: TemplateVars) => {
    const role = vars.role || 'these roles';
    
    return `Totally understand — most agencies charge 15–25%, but we keep it simple at 10% with a 6-month guarantee.

Roles like ${role} require deeper vetting, and we focus on sending candidates who are ready to contribute immediately.

If you'd like, I can send the agreement so you can review everything.`;
  },

  /**
   * 8. ROLE_UNCLEAR - When the Role Is Unclear
   */
  ROLE_UNCLEAR: (vars: TemplateVars) => {
    // Only use role if it's actually provided - avoid "position, position" bug
    if (vars.role) {
      return `Thanks for the reply — just to confirm, is this for the ${vars.role} position?

Our terms are a simple 10% fee with a 6-month guarantee, and we have strong candidates ready for roles like this.

Once we're aligned on the role, would you like me to send the agreement?`;
    }
    
    // If no role provided, use generic phrasing without repeating "position"
    return `Thanks for the reply — just to confirm, which role are you looking to fill?

Our terms are a simple 10% fee with a 6-month guarantee, and we have strong candidates ready.

Once we're aligned on the role, would you like me to send the agreement?`;
  },

  /**
   * 9. ALREADY_HAVE_AGENCY - When They Already Have an Agency
   */
  ALREADY_HAVE_AGENCY: (vars: TemplateVars) => {
    return `Totally understand — always good to have trusted partners.

Many clients use us alongside their current agency because we move quickly, stay at 10%, and include a 6-month guarantee.

Open to giving us a shot? If so, I can send the agreement.`;
  },

  /**
   * 10. NOT_HIRING_CONTACT - When They're Not the Hiring Contact (legacy - kept for backward compatibility)
   */
  NOT_HIRING_CONTACT: (vars: TemplateVars, flags?: TemplateFlags) => {
    // If contact info is already provided, just acknowledge it
    if (flags?.contact_info_provided) {
      const contactName = vars.contact_name ? ` ${vars.contact_name}` : '';
      const contactEmail = vars.contact_email ? ` (${vars.contact_email})` : '';
      
      return `Thanks for the heads-up — appreciate it.

I'll reach out to${contactName}${contactEmail} instead.

We keep things simple at 10% with a 6-month guarantee.

I can send them the agreement to review.`;
    }

    return `Thanks for the heads-up — appreciate it.

We keep things simple at 10% with a 6-month guarantee.

Would you mind connecting me with the correct hiring contact?

I can send them the agreement to review.`;
  },

  /**
   * 10a. WRONG_PERSON_WITH_CONTACT - When They're Not the Right Person and Provide Valid Contact Info
   */
  WRONG_PERSON_WITH_CONTACT: (vars: TemplateVars) => {
    const contactName = vars.contact_name ? ` ${vars.contact_name}` : '';
    const contactEmail = vars.contact_email ? ` (${vars.contact_email})` : '';
    
    return `Thanks for the heads-up — really appreciate it.

I'll reach out to${contactName}${contactEmail} and keep you copied so you're in the loop.

If there's anyone else who should be included on hiring conversations, feel free to let me know.`;
  },

  /**
   * 10b. WRONG_PERSON_NO_CONTACT - When They're Not the Right Person and No Contact Info Provided
   * Note: This template should NOT be used (handler skips reply), but kept for completeness
   */
  WRONG_PERSON_NO_CONTACT: (vars: TemplateVars) => {
    // This template should not be used - handler skips reply for this case
    // But kept here for reference
    return `Thanks for the heads-up — would you mind CC'ing me or sharing the best contact for hiring instead?

Happy to reach out to them directly if easier and keep you copied so you're in the loop.`;
  },

  /**
   * 11. LINK_TO_APPLY - When They Give a Link to Apply
   */
  LINK_TO_APPLY: (vars: TemplateVars) => {
    return `Thanks for sharing this — just to clarify, we're a recruiting partner that sources and vets candidates for our clients.

We can't use an external apply link unless we have an agreement in place.

Our terms are a simple 10% fee with a 6-month guarantee.

If it makes sense, I can send the agreement over.`;
  },

  /**
   * 12. FEES_QUESTION - When They Ask if There Are Fees
   */
  FEES_QUESTION: (vars: TemplateVars) => {
    const role = vars.role || vars.role1;
    const positionInfo = role ? `\n\nJust to confirm, is this for the ${role} position?` : '';
    
    return `Great question — we only charge if you hire someone we present.

It's a simple 10% contingency model with a 6-month replacement guarantee.

No upfront fees.${positionInfo}

Would you like me to send the agreement?`;
  },

  /**
   * 13. PERCENT_TOO_HIGH - When They Say the Percentage Is Too High
   */
  PERCENT_TOO_HIGH: (vars: TemplateVars) => {
    return `Totally understand — here's why we stay at 10%:

Most agencies charge 15–25%
We send vetted candidates, not volume
You get a U.S.-based recruiting team
Includes a 6-month replacement guarantee

If you're open to it, I can send the agreement so you can review everything.`;
  },

  /**
   * 14. SKEPTICAL - When They Express Skepticism About the Email
   */
  SKEPTICAL: (vars: TemplateVars) => {
    const role1 = vars.role1 || vars.role || 'the role';
    const role2 = vars.role2;
    const rolesMentioned = role2 ? ` (or both positions you mentioned)` : '';
    
    return `Thanks for the reply — totally understandable question.

Yes, we reached out proactively because we regularly place roles in the Pacific Northwest as well, and we only reach out when we actually have screened candidates ready to share.

We don't spam lists — we only message companies where we believe we can add value.

If you want, I can send over the candidate details${rolesMentioned}.

Would you like me to send the agreement so we can share the full resumes without redactions?`;
  },

  /**
   * 15. ROLE_CLARIFICATION_MULTI - When They Explicitly List Multiple Roles
   */
  ROLE_CLARIFICATION_MULTI: (vars: TemplateVars) => {
    const role1 = vars.role1 || vars.role || 'the first role';
    const role2 = vars.role2 || 'the second role';
    
    return `Appreciate the clarity — thank you.

We can support both roles.

For ${role1}, we have strong candidates ready to share.

For ${role2}, we have strong candidates ready to share.

We keep things simple: flat 10% fee and a 6-month guarantee.

If you'd like me to send the agreement, I can share the full resumes without redactions.`;
  },

  /**
   * 16. GEO_CONCERN - When They Express Geographic Concerns
   */
  GEO_CONCERN: (vars: TemplateVars) => {
    const location = vars.location || 'your area';
    
    return `Totally fair question.

Yes — the candidates we're reaching out about are local to ${location}.

We only open conversations when we already have people screened and available.

If you'd like, I can send the agreement so we can share full details without redactions.`;
  },

  /**
   * 17. ASKING_WHICH_ROLE - When They Ask "What Roles?" or "Which Position?"
   */
  ASKING_WHICH_ROLE: (vars: TemplateVars) => {
    const role1 = vars.role1 || 'the role';
    const role2 = vars.role2;
    
    // If we have both role guesses, mention both
    if (role1 && role2 && role1 !== role2) {
      return `Great question — based on companies your size, we typically support roles like:

• ${role1}
• ${role2}

Our terms are a simple 10% fee with a 6-month replacement guarantee.

Which of these roles are you looking to fill? Once I know, I can send the agreement over.`;
    }
    
    // If we only have one role guess
    if (role1) {
      return `Great question — based on companies your size, we typically support roles like ${role1}.

Our terms are a simple 10% fee with a 6-month replacement guarantee.

Is that the role you're looking to fill? If so, I can send the agreement over.`;
    }
    
    // Fallback if no role guesses
    return `Great question — we support a wide range of roles.

Our terms are a simple 10% fee with a 6-month replacement guarantee.

What role are you looking to fill? Once I know, I can send the agreement over.`;
  },

  /**
   * 18. ASK_FEES_ONLY - When They Ask About Fees Only (No Position Mentioned)
   */
  ASK_FEES_ONLY: (vars: TemplateVars) => {
    return `Great question — we only charge if you hire someone we present.

It's a simple 10% contingency model with a 6-month replacement guarantee.

No upfront fees.

Would you like me to send the agreement?`;
  },

  /**
   * 19. ASK_WEBSITE - When They Ask for Website
   */
  ASK_WEBSITE: (vars: TemplateVars) => {
    // Note: Website URL should be provided via vars.website_url or use a default
    const websiteUrl = vars.website_url || 'https://alphahire.com'; // Update with actual website
    
    return `Great question — yes, you can see more about us here: ${websiteUrl}

For quick context: we work on a flat 10% fee with a 6-month replacement guarantee.

If it looks like a fit, I can send over the agreement and a couple of candidate profiles to review.`;
  },

  /**
   * 20. DONE_ALL_SET - When They Say "We're All Set" or Similar
   * NOTE: This template is NOT used - handler skips reply and marks thread as closed
   * Kept here for reference only
   */
  DONE_ALL_SET: (vars: TemplateVars) => {
    // This template should not be used - handler skips reply for this case
    // But kept here for reference
    return `Thanks for letting me know — appreciate it.

If anything changes, feel free to reach out.`;
  },

  /**
   * 21. ROLE_CONFIRMED_FOLLOWUP - When Role Is Already Locked/Confirmed
   */
  ROLE_CONFIRMED_FOLLOWUP: (vars: TemplateVars) => {
    const rolesList = vars.locked_roles || vars.role || 'the role';
    
    return `Thanks for confirming — understood, you're focused on the ${rolesList} role.

We work on a flat 10% fee with a 6-month replacement guarantee and already have candidates lined up for this type of position.

If that sounds reasonable, would you like me to send the agreement so we can share full candidate details without redactions?`;
  },

  /**
   * 22. ASK_COMPANY - When They Ask About the Company
   */
  ASK_COMPANY: (vars: TemplateVars) => {
    return `Great question — we're AlphaHire, a recruitment agency specializing in placing top talent for companies like yours.

We work on a flat 10% fee with a 6-month replacement guarantee, and we focus on sending you candidates who are ready to contribute immediately.

If it sounds like a fit, I can send over the agreement and a couple of candidate profiles to review.`;
  },

  /**
   * 23. ASK_EXPERIENCE - When They Ask About Candidate Experience
   */
  ASK_EXPERIENCE: (vars: TemplateVars) => {
    const role = vars.role || vars.role1 || 'these roles';
    return `Great question — we focus on candidates with strong, relevant experience for ${role} positions.

Our candidates are pre-vetted and ready to contribute immediately. We only send profiles that match your specific requirements.

Would you like me to send the agreement so we can share full candidate details?`;
  },

  /**
   * 24. ASK_SALARY - When They Ask About Salary Range
   */
  ASK_SALARY: (vars: TemplateVars) => {
    return `Great question — salary ranges vary based on the specific role, location, and experience level.

Once we know the exact position you're looking to fill, I can provide more specific salary information for candidates in that range.

What role are you looking to fill? I can send the agreement and candidate profiles with salary details.`;
  },

  /**
   * 22. ASK_SOURCE - When They Ask "Where Did You Get My Info?"
   */
  ASK_SOURCE: (vars: TemplateVars) => {
    return `Great question — we use a combination of public business directories, company websites, and professional networks to identify companies that might benefit from our services.

We only reach out when we believe we can genuinely help with your hiring needs.

If you'd like to see how we can help, I can send over the agreement and some candidate profiles.`;
  },

  /**
   * 23. FORWARD_TO_TEAM - When They Say "I'll Forward to Team"
   */
  FORWARD_TO_TEAM: (vars: TemplateVars) => {
    return `Perfect — thanks for forwarding it along.

If your team has any questions or wants to move forward, feel free to reply here and I'll send the agreement over.

I'll follow up in a few days to see if there's interest.`;
  },

  /**
   * 24. CHECK_WITH_HR - When They Say "I'll Check with HR"
   */
  CHECK_WITH_HR: (vars: TemplateVars) => {
    return `Sounds good — happy to wait while you check with HR.

If they're interested, just reply here and I'll send the agreement over.

I'll follow up in a few days to see where things stand.`;
  },

  /**
   * 25. CONFUSED_MESSAGE - When They're Confused About Initial Message
   */
  CONFUSED_MESSAGE: (vars: TemplateVars) => {
    return `No worries — let me clarify.

We're AlphaHire, a recruitment agency. We help companies fill tough-to-hire roles with pre-vetted candidates.

We work on a flat 10% fee with a 6-month replacement guarantee.

If that sounds like something your team could use, I can send the agreement and some candidate profiles to review.`;
  },

  /**
   * 26. THANK_YOU - When They Say "Thank You"
   */
  THANK_YOU: (vars: TemplateVars) => {
    return `You're welcome!

If you'd like to move forward, just let me know and I'll send the agreement over.

Otherwise, I'll follow up in a few days to see if there's interest.`;
  },

  /**
   * 27. SINGLE_QUESTION_MARK - When They Reply with Just "?"
   */
  SINGLE_QUESTION_MARK: (vars: TemplateVars) => {
    return `Happy to clarify — we're AlphaHire, a recruitment agency that helps companies fill tough-to-hire roles.

We work on a flat 10% fee with a 6-month replacement guarantee.

If you're interested, I can send the agreement and some candidate profiles to review. What role are you looking to fill?`;
  },

  /**
   * 28. HYBRID_WORK - When They Ask About Hybrid Work Arrangements
   */
  HYBRID_WORK: (vars: TemplateVars) => {
    return `Great question — we work with candidates across all work arrangements (remote, hybrid, and on-site).

Once we know the specific role and requirements, I can send candidates who match your work arrangement preferences.

What role are you looking to fill? I can send the agreement and candidate profiles.`;
  },

  /**
   * 29. PDF_FORMAT - When They Ask for PDF Format
   */
  PDF_FORMAT: (vars: TemplateVars) => {
    return `Absolutely — the agreement will be sent via SignWell (e-signature platform), which allows you to download it as a PDF after signing.

You'll receive a copy in your email once it's signed.

Would you like me to send it over now?`;
  },

  /**
   * 30. WILL_FORWARD - When They Say "I'll Forward" or "Will Forward"
   */
  WILL_FORWARD: (vars: TemplateVars) => {
    return `Perfect — thanks for forwarding it along.

If there's interest, just reply here and I'll send the agreement over.

I'll follow up in a few days to see if your team wants to move forward.`;
  },
};

/**
 * Get script for a template ID with variable substitution
 * @param templateId - Template identifier
 * @param vars - Variables to substitute in the script
 * @param flags - Optional flags for conditional template logic
 * @returns Formatted email text
 */
export function getScript(templateId: string, vars: TemplateVars = {}, flags?: TemplateFlags): string {
  const template = TPL[templateId];
  
  if (!template) {
    throw new Error(`Unknown template_id: ${templateId}`);
  }
  
  return template(vars, flags);
}

/**
 * Get follow-up email text after agreement is sent
 * @returns Follow-up email text
 */
export function getFollowUpEmailText(): string {
  return `Ok great, we just sent you the agreement via Signwell, feel free to reach out with any questions.`;
}

/**
 * Templates that automatically send agreements
 */
export const AUTO_SEND_TEMPLATES = new Set<string>(['YES_SEND', 'ASK_AGREEMENT']);

/**
 * Check if template requires e-signature
 * @param templateId - Template identifier
 * @returns true if template requires e-signature
 */
export function requiresESignature(templateId: string): boolean {
  return AUTO_SEND_TEMPLATES.has(templateId);
}
