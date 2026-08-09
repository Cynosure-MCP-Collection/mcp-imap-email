#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ImapFlow } from 'imapflow';
import type { FetchMessageObject, SearchObject, MessageEnvelopeObject, MessageStructureObject } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';

// ── Config ─────────────────────────────────────────────────────────────────────

function imapConfig() {
    const host = process.env.IMAP_HOST;
    if (!host) throw new Error('IMAP_HOST environment variable is required');
    return {
        host,
        port: Number(process.env.IMAP_PORT || '993'),
        secure: (process.env.IMAP_PORT || '993') === '993',
        auth: {
            user: process.env.IMAP_USER || '',
            pass: process.env.IMAP_PASSWORD || '',
        },
        logger: false as const,
    };
}

function smtpConfig() {
    return {
        host: process.env.SMTP_HOST || process.env.IMAP_HOST || '',
        port: Number(process.env.SMTP_PORT || '587'),
        secure: (process.env.SMTP_PORT || '587') === '465',
        auth: {
            user: process.env.SMTP_USER || process.env.IMAP_USER || '',
            pass: process.env.SMTP_PASSWORD || process.env.IMAP_PASSWORD || '',
        },
    };
}

function getFromAddress(): string {
    return process.env.EMAIL_FROM || process.env.IMAP_USER || '';
}

// ── IMAP helper ────────────────────────────────────────────────────────────────

async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow(imapConfig());
    await client.connect();
    try {
        return await fn(client);
    } finally {
        await client.logout();
    }
}

// ── Envelope formatting (context-efficient) ────────────────────────────────────

function formatAddress(addr?: { name?: string; address?: string }[]): string {
    if (!addr || addr.length === 0) return '';
    return addr.map(a => a.name ? `${a.name} <${a.address}>` : a.address || '').join(', ');
}

function formatEnvelope(msg: FetchMessageObject): Record<string, unknown> {
    const env = msg.envelope;
    return {
        uid: msg.uid,
        seq: msg.seq,
        date: env?.date?.toISOString?.() ?? String(env?.date ?? ''),
        subject: env?.subject ?? '',
        from: formatAddress(env?.from),
        to: formatAddress(env?.to),
        cc: formatAddress(env?.cc),
        messageId: env?.messageId ?? '',
        flags: msg.flags ? [...msg.flags] : [],
        size: msg.size,
    };
}

// ── Attachment metadata from BODYSTRUCTURE ─────────────────────────────────────

interface AttachmentMeta {
    part: string;
    filename: string;
    contentType: string;
    size: number;
}

function extractAttachments(structure?: MessageStructureObject): AttachmentMeta[] {
    if (!structure) return [];
    const result: AttachmentMeta[] = [];

    function walk(node: MessageStructureObject) {
        const disp = node.disposition?.toLowerCase();
        if (disp === 'attachment' || disp === 'inline') {
            const filename =
                node.dispositionParameters?.filename ||
                node.parameters?.name ||
                `part-${node.part}`;
            result.push({
                part: node.part || '1',
                filename,
                contentType: node.type,
                size: node.size || 0,
            });
        }
        if (node.childNodes) {
            for (const child of node.childNodes) walk(child);
        }
    }

    walk(structure);
    return result;
}

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
    name: 'IMAP Email',
    version: '1.0.0',
    title: 'IMAP Email',
    description: 'Read, search, draft, and send emails via IMAP/SMTP.',
    icons: [{ src: 'https://raw.githubusercontent.com/andreasjhagen/Cynosure-MCPs/main/mcp-imap-email/icon.png', mimeType: 'image/png' }],
});

// ── Tool: list_folders ─────────────────────────────────────────────────────────

server.registerTool(
    'list_folders',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'List all mailbox folders with message counts',
    },
    async () => {
        const folders = await withImap(async (client) => {
            return client.list({
                statusQuery: { messages: true, unseen: true },
            });
        });

        const result = folders.map(f => ({
            path: f.path,
            name: f.name,
            specialUse: f.specialUse || null,
            messages: f.status?.messages ?? null,
            unseen: f.status?.unseen ?? null,
            flags: [...f.flags],
        }));

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
);

// ── Tool: list_emails ──────────────────────────────────────────────────────────

server.registerTool(
    'list_emails',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'List emails in a folder (headers only — context-efficient). Returns newest first.',
        inputSchema: {
            folder: z.string().default('INBOX').describe('Mailbox folder path'),
            limit: z.number().min(1).max(200).default(20).describe('Max emails to return'),
            offset: z.number().min(0).default(0).describe('Number of recent emails to skip'),
        },
    },
    async ({ folder, limit, offset }) => {
        const emails = await withImap(async (client) => {
            const mailbox = await client.mailboxOpen(folder, { readOnly: true });
            const total = mailbox.exists;
            if (total === 0) return [];

            // Calculate sequence range: newest first
            const end = total - offset;
            const start = Math.max(1, end - limit + 1);
            if (end < 1) return [];

            const range = `${start}:${end}`;
            const messages = await client.fetchAll(range, {
                uid: true,
                envelope: true,
                flags: true,
                size: true,
            });

            return messages.reverse().map(formatEnvelope);
        });

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({ count: emails.length, emails }, null, 2),
            }],
        };
    },
);

// ── Tool: get_email ────────────────────────────────────────────────────────────

server.registerTool(
    'get_email',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        description: 'Get full email content by UID. Returns parsed text body, HTML flag, attachments metadata.',
        inputSchema: {
            folder: z.string().default('INBOX').describe('Mailbox folder path'),
            uid: z.number().describe('Email UID'),
            markRead: z.boolean().default(false).describe('Mark email as read'),
            maxBodyLength: z.number().default(50000).describe('Max body text length to return'),
        },
    },
    async ({ folder, uid, markRead, maxBodyLength }) => {
        const result = await withImap(async (client) => {
            const lock = await client.getMailboxLock(folder);
            try {
                // Fetch source
                const msg = await client.fetchOne(String(uid), {
                    uid: true,
                    source: true,
                    envelope: true,
                    bodyStructure: true,
                    flags: true,
                    size: true,
                }, { uid: true });

                if (!msg) return { error: `Email UID ${uid} not found` };

                // Mark as read if requested
                if (markRead) {
                    await client.messageFlagsAdd({ uid: String(uid) }, ['\\Seen'], { uid: true });
                }

                // Parse the message
                const parsed: ParsedMail = await simpleParser(msg.source!);

                // Prefer text body; fall back to stripped HTML
                let body = parsed.text || '';
                const hasHtml = !!parsed.html;
                if (!body && parsed.html) {
                    // Rough HTML to text
                    body = parsed.html
                        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                        .replace(/<[^>]+>/g, ' ')
                        .replace(/&nbsp;/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                }
                if (body.length > maxBodyLength) {
                    body = body.slice(0, maxBodyLength) + '\n... [truncated]';
                }

                const attachments = extractAttachments(msg.bodyStructure);

                return {
                    ...formatEnvelope(msg),
                    body,
                    hasHtml,
                    attachments,
                    inReplyTo: msg.envelope?.inReplyTo || null,
                    replyTo: formatAddress(msg.envelope?.replyTo),
                };
            } finally {
                lock.release();
            }
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
);

// ── Tool: search_emails ────────────────────────────────────────────────────────

server.registerTool(
    'search_emails',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'Search emails in a folder. Returns headers only (context-efficient). Supports from, to, subject, body, date filters, flags.',
        inputSchema: {
            folder: z.string().default('INBOX').describe('Mailbox folder path'),
            from: z.string().optional().describe('Filter by From address'),
            to: z.string().optional().describe('Filter by To address'),
            subject: z.string().optional().describe('Filter by subject (partial match)'),
            body: z.string().optional().describe('Full-text search in message body'),
            since: z.string().optional().describe('Messages since date (YYYY-MM-DD)'),
            before: z.string().optional().describe('Messages before date (YYYY-MM-DD)'),
            unseen: z.boolean().optional().describe('Only unread messages'),
            flagged: z.boolean().optional().describe('Only flagged/starred messages'),
            limit: z.number().min(1).max(200).default(50).describe('Max results'),
        },
    },
    async ({ folder, from, to, subject, body, since, before, unseen, flagged, limit }) => {
        const emails = await withImap(async (client) => {
            const lock = await client.getMailboxLock(folder);
            try {
                const query: SearchObject = {};
                if (from) query.from = from;
                if (to) query.to = to;
                if (subject) query.subject = subject;
                if (body) query.body = body;
                if (since) query.since = since;
                if (before) query.before = before;
                if (unseen === true) query.seen = false;
                if (flagged === true) query.flagged = true;

                const uids = await client.search(query, { uid: true });
                if (!uids || uids.length === 0) return [];

                // Take only the latest N UIDs
                const selected = uids.slice(-limit);
                const range = selected.join(',');

                const messages = await client.fetchAll(range, {
                    uid: true,
                    envelope: true,
                    flags: true,
                    size: true,
                }, { uid: true });

                return messages.reverse().map(formatEnvelope);
            } finally {
                lock.release();
            }
        });

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({ count: emails.length, emails }, null, 2),
            }],
        };
    },
);

// ── Tool: send_email ───────────────────────────────────────────────────────────

server.registerTool(
    'send_email',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: 'Send an email via SMTP',
        inputSchema: {
            to: z.string().describe('Recipient email address(es), comma-separated'),
            subject: z.string().describe('Email subject'),
            text: z.string().optional().describe('Plain text body'),
            html: z.string().optional().describe('HTML body (optional)'),
            cc: z.string().optional().describe('CC recipients, comma-separated'),
            bcc: z.string().optional().describe('BCC recipients, comma-separated'),
            replyTo: z.string().optional().describe('Reply-To address'),
            inReplyTo: z.string().optional().describe('Message-ID being replied to'),
        },
    },
    async ({ to, subject, text, html, cc, bcc, replyTo, inReplyTo }) => {
        const transporter = nodemailer.createTransport(smtpConfig());
        try {
            const info = await transporter.sendMail({
                from: getFromAddress(),
                to,
                cc: cc || undefined,
                bcc: bcc || undefined,
                replyTo: replyTo || undefined,
                inReplyTo: inReplyTo || undefined,
                subject,
                text: text || undefined,
                html: html || undefined,
            });
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        success: true,
                        messageId: info.messageId,
                        accepted: info.accepted,
                        rejected: info.rejected,
                    }, null, 2),
                }],
            };
        } finally {
            transporter.close();
        }
    },
);

// ── Tool: create_draft ─────────────────────────────────────────────────────────

server.registerTool(
    'create_draft',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: 'Save a draft email to the Drafts folder via IMAP APPEND',
        inputSchema: {
            to: z.string().describe('Recipient email address(es), comma-separated'),
            subject: z.string().describe('Email subject'),
            text: z.string().optional().describe('Plain text body'),
            html: z.string().optional().describe('HTML body (optional)'),
            cc: z.string().optional().describe('CC recipients, comma-separated'),
            draftsFolder: z.string().default('Drafts').describe('Drafts folder path'),
        },
    },
    async ({ to, subject, text, html, cc, draftsFolder }) => {
        // Build a proper RFC822 message
        const lines: string[] = [];
        lines.push(`From: ${getFromAddress()}`);
        lines.push(`To: ${to}`);
        if (cc) lines.push(`Cc: ${cc}`);
        lines.push(`Subject: ${subject}`);
        lines.push(`Date: ${new Date().toUTCString()}`);
        lines.push(`MIME-Version: 1.0`);
        if (html) {
            lines.push(`Content-Type: text/html; charset=utf-8`);
            lines.push('');
            lines.push(html);
        } else {
            lines.push(`Content-Type: text/plain; charset=utf-8`);
            lines.push('');
            lines.push(text || '');
        }
        const rfc822 = lines.join('\r\n');

        const result = await withImap(async (client) => {
            // Try to find the drafts folder
            const folders = await client.list();
            const drafts = folders.find(f =>
                f.specialUse === '\\Drafts' ||
                f.path.toLowerCase() === draftsFolder.toLowerCase()
            );
            const targetPath = drafts?.path || draftsFolder;

            const appendResult = await client.append(targetPath, rfc822, ['\\Draft', '\\Seen']);
            return {
                success: true,
                folder: targetPath,
                uid: appendResult ? appendResult.uid : null,
            };
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
);

// ── Tool: move_email ───────────────────────────────────────────────────────────

server.registerTool(
    'move_email',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        description: 'Move an email to another folder',
        inputSchema: {
            folder: z.string().default('INBOX').describe('Source folder'),
            uid: z.number().describe('Email UID to move'),
            destination: z.string().describe('Destination folder path'),
        },
    },
    async ({ folder, uid, destination }) => {
        const result = await withImap(async (client) => {
            const lock = await client.getMailboxLock(folder);
            try {
                const moveResult = await client.messageMove(String(uid), destination, { uid: true });
                return {
                    success: !!moveResult,
                    destination: moveResult ? moveResult.destination : destination,
                };
            } finally {
                lock.release();
            }
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
);

// ── Tool: flag_email ───────────────────────────────────────────────────────────

server.registerTool(
    'flag_email',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        description: 'Set or remove flags on an email (e.g. \\Seen, \\Flagged, \\Answered, \\Deleted)',
        inputSchema: {
            folder: z.string().default('INBOX').describe('Mailbox folder path'),
            uid: z.number().describe('Email UID'),
            addFlags: z.array(z.string()).optional().describe('Flags to add, e.g. ["\\\\Seen", "\\\\Flagged"]'),
            removeFlags: z.array(z.string()).optional().describe('Flags to remove'),
        },
    },
    async ({ folder, uid, addFlags, removeFlags }) => {
        const result = await withImap(async (client) => {
            const lock = await client.getMailboxLock(folder);
            try {
                if (addFlags && addFlags.length > 0) {
                    await client.messageFlagsAdd(String(uid), addFlags, { uid: true });
                }
                if (removeFlags && removeFlags.length > 0) {
                    await client.messageFlagsRemove(String(uid), removeFlags, { uid: true });
                }
                // Fetch updated flags
                const msg = await client.fetchOne(String(uid), { uid: true, flags: true }, { uid: true });
                return {
                    success: true,
                    uid,
                    flags: msg ? [...(msg.flags || [])] : [],
                };
            } finally {
                lock.release();
            }
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
);

// ── Tool: delete_email ─────────────────────────────────────────────────────────

server.registerTool(
    'delete_email',
    {
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        description: 'Delete an email (moves to Trash or permanently deletes)',
        inputSchema: {
            folder: z.string().default('INBOX').describe('Mailbox folder path'),
            uid: z.number().describe('Email UID to delete'),
            permanent: z.boolean().default(false).describe('If true, permanently delete instead of moving to Trash'),
        },
    },
    async ({ folder, uid, permanent }) => {
        const result = await withImap(async (client) => {
            const lock = await client.getMailboxLock(folder);
            try {
                if (permanent) {
                    await client.messageDelete(String(uid), { uid: true });
                    return { success: true, action: 'permanently deleted' };
                }

                // Try to find Trash folder
                const folders = await client.list();
                const trash = folders.find(f => f.specialUse === '\\Trash');
                if (trash) {
                    await client.messageMove(String(uid), trash.path, { uid: true });
                    return { success: true, action: 'moved to trash', trash: trash.path };
                }

                // Fallback: mark as deleted
                await client.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true });
                return { success: true, action: 'marked as deleted (no Trash folder found)' };
            } finally {
                lock.release();
            }
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
);

// ── Tool: get_attachment ───────────────────────────────────────────────────────

server.registerTool(
    'get_attachment',
    {
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        description: 'Download a specific attachment from an email by body part number. Returns base64-encoded content.',
        inputSchema: {
            folder: z.string().default('INBOX').describe('Mailbox folder path'),
            uid: z.number().describe('Email UID'),
            part: z.string().describe('Body part number (from get_email attachments metadata)'),
        },
    },
    async ({ folder, uid, part }) => {
        const result = await withImap(async (client) => {
            const lock = await client.getMailboxLock(folder);
            try {
                const download = await client.download(String(uid), part, { uid: true });
                const chunks: Buffer[] = [];
                for await (const chunk of download.content) {
                    chunks.push(Buffer.from(chunk));
                }
                const content = Buffer.concat(chunks);

                return {
                    filename: download.meta.filename || `part-${part}`,
                    contentType: download.meta.contentType || 'application/octet-stream',
                    size: content.length,
                    content: content.toString('base64'),
                };
            } finally {
                lock.release();
            }
        });

        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
);

// ── Start ──────────────────────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
