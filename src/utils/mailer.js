import nodemailer from 'nodemailer'
import { env } from '../config/env.js'
import { formatMoney } from '../config/currencies.js'
import { escapeHtml } from './text.js'

let transporter

function getTransporter() {
  if (!env.mail.host || !env.mail.user || !env.mail.password) return null
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.mail.host,
      port: env.mail.port,
      secure: env.mail.port === 465,
      auth: { user: env.mail.user, pass: env.mail.password },
    })
  }
  return transporter
}

export function frontendLink(path, token) {
  return `${env.webAppUrl}${path}?token=${encodeURIComponent(token)}`
}

function layout(title, bodyHtml) {
  return `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>${bodyHtml}
<p style="margin-top:32px;font-size:12px;color:#64748b">You received this email because of activity on your Lembro account. If this wasn't you, you can ignore it.</p></div>`
}

export function linkEmail({ heading, intro, linkText, url }) {
  return {
    text: `${intro}\n\n${url}`,
    html: layout(heading, `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(url)}" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${escapeHtml(linkText)}</a></p><p style="font-size:12px;color:#64748b;word-break:break-all">${escapeHtml(url)}</p>`),
  }
}

export async function sendEmail({ to, subject, text, html }) {
  const activeTransporter = getTransporter()
  if (!activeTransporter) {
    if (env.isProduction) throw new Error('Email delivery is not configured.')
    // Development convenience: print the message so verification / reset links are usable
    // without an SMTP server.
    console.warn(`[mail] SMTP not configured - email to ${to}\n  Subject: ${subject}\n  ${text.replaceAll('\n', '\n  ')}`)
    return
  }
  await activeTransporter.sendMail({ from: env.mail.from, to, subject, text, html })
}

// Backwards-compatible name used by the auth routes.
export const sendAuthEmail = sendEmail

export function orderConfirmationEmail(order) {
  const money = (amount) => formatMoney(amount, order.currency)
  const lines = order.items.map((item) => `${item.productNameSnapshot}${item.variantLabel ? ` (${item.variantLabel})` : ''} x ${item.quantity} - ${money(item.lineTotalAmount)}`)
  const payment = order.paymentMethod === 'cod'
    ? `Payment: cash on delivery - please have ${money(order.totalAmount)} ready when your order arrives.`
    : 'Payment: paid online. Thank you!'
  return {
    text: `Thank you for your order ${order.number}.\n\n${lines.join('\n')}\n\nTotal: ${money(order.totalAmount)}\n${payment}`,
    html: layout(`Thank you for your order ${order.number}`, `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul><p><strong>Total: ${escapeHtml(money(order.totalAmount))}</strong></p><p>${escapeHtml(payment)}</p>`),
  }
}
