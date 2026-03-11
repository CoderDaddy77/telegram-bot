import os
import sys
import json
import asyncio
import threading
import random
from datetime import datetime, date

from flask import Flask
from dotenv import load_dotenv

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    ContextTypes,
    filters,
)

# ======================
# CONFIG
# ======================

load_dotenv()

TOKEN = os.getenv("BOT_TOKEN")
CHANNEL_ID = int(os.getenv("CHANNEL_ID"))
ADMIN_IDS = [int(x.strip()) for x in os.getenv("ADMIN_IDS", "").split(",") if x.strip()]

DATA_FILE = "data.json"
PAGE_SIZE = 5
MAX_PER_REQUEST = 10
DAILY_LIMIT = 50

# ======================
# DATA HELPERS
# ======================

def load_data():
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

def save_data(data):
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)

def is_admin(user_id):
    return user_id in ADMIN_IDS

def get_all_videos(data):
    all_vids = []
    for ids in data["categories"].values():
        all_vids.extend(ids)
    return all_vids

def track_user(data, user_id):
    uid = str(user_id)
    if uid not in data["user_stats"]:
        data["user_stats"][uid] = {
            "total_requests": 0,
            "daily_count": 0,
            "last_date": "",
            "fav_categories": {}
        }
    if user_id not in data["known_users"]:
        data["known_users"].append(user_id)
    return data

def check_daily_limit(data, user_id, count):
    """Returns (allowed_count, remaining). Admins get unlimited."""
    if is_admin(user_id):
        return count, 999999

    uid = str(user_id)
    stats = data["user_stats"].get(uid, {})
    today = str(date.today())

    if stats.get("last_date") != today:
        stats["daily_count"] = 0
        stats["last_date"] = today

    used = stats.get("daily_count", 0)
    remaining = max(0, DAILY_LIMIT - used)
    allowed = min(count, remaining)
    return allowed, remaining

def update_user_stats(data, user_id, category, count):
    uid = str(user_id)
    stats = data["user_stats"][uid]
    today = str(date.today())

    if stats.get("last_date") != today:
        stats["daily_count"] = 0
        stats["last_date"] = today

    stats["total_requests"] += 1
    stats["daily_count"] += count

    if category not in ("🎲 Random", "🆕 Latest", "🔥 Surprise"):
        cats = stats.get("fav_categories", {})
        cats[category] = cats.get(category, 0) + count
        stats["fav_categories"] = cats

    save_data(data)

# ======================
# KEEP ALIVE (Replit)
# ======================

flask_app = Flask("")

@flask_app.route("/")
def home():
    return "Bot running ✅"

def run_flask():
    flask_app.run(host="0.0.0.0", port=8080)

def keep_alive():
    t = threading.Thread(target=run_flask)
    t.start()

# ======================
# PAGINATION: SEND FILES
# ======================

async def send_page(update, context, msg_ids, page, category):
    """Forward a single page of files and show pagination buttons."""
    total = len(msg_ids)
    total_pages = max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)
    page = max(0, min(page, total_pages - 1))

    start = page * PAGE_SIZE
    end = min(start + PAGE_SIZE, total)
    page_ids = msg_ids[start:end]

    chat_id = update.effective_chat.id

    # Track sent message IDs for /clear
    if "sent_messages" not in context.user_data:
        context.user_data["sent_messages"] = []

    # Send files first
    for msg_id in page_ids:
        try:
            fwd = await context.bot.forward_message(
                chat_id=chat_id,
                from_chat_id=CHANNEL_ID,
                message_id=msg_id
            )
            context.user_data["sent_messages"].append(fwd.message_id)
        except Exception:
            pass  # Skip deleted/inaccessible messages

    # Build pagination buttons
    buttons = []
    if page > 0:
        buttons.append(InlineKeyboardButton("⬅️ Prev", callback_data=f"page_{category}_{page-1}"))
    buttons.append(InlineKeyboardButton(f"📄 {page+1}/{total_pages}", callback_data="noop"))
    if page < total_pages - 1:
        buttons.append(InlineKeyboardButton("Next ➡️", callback_data=f"page_{category}_{page+1}"))

    keyboard = [buttons]

    # Add save to favorites button
    keyboard.append([InlineKeyboardButton("⭐ Save All to Favorites", callback_data=f"savepage_{start}_{end}_{category}")])

    # Send info + buttons AFTER the files
    info_msg = await context.bot.send_message(
        chat_id=chat_id,
        text=f"✅ Sent {len(page_ids)} files ({start+1}-{end} of {total})",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )
    context.user_data["sent_messages"].append(info_msg.message_id)

async def send_category(update, context, category, count):
    """Prepare the message IDs for a category and send the first page."""
    data = load_data()
    all_vids = get_all_videos(data)
    user_id = update.effective_user.id

    if category == "🎲 Random":
        pool = all_vids
        ids = random.sample(pool, min(count, len(pool)))
    elif category == "🆕 Latest":
        ids = sorted(all_vids, reverse=True)[:count]
    elif category == "🔥 Surprise":
        cats = list(data["categories"].keys())
        if cats:
            rand_cat = random.choice(cats)
            pool = data["categories"][rand_cat]
            ids = random.sample(pool, min(count, len(pool)))
        else:
            ids = []
    else:
        ids = data["categories"].get(category, [])[:count]

    if not ids:
        await update.message.reply_text("❌ Is category mein koi content nahi hai.")
        return

    # Store selected IDs for pagination
    context.user_data["current_ids"] = ids
    context.user_data["current_category"] = category

    # Update stats
    data = load_data()
    track_user(data, user_id)
    update_user_stats(data, user_id, category, len(ids))

    await send_page(update, context, ids, 0, category)

# ======================
# /start COMMAND
# ======================

WELCOME_TEXT = """
╔══════════════════════════════╗
║    🤖 SmartBot — Premium     ║
╠══════════════════════════════╣
║                              ║
║  🎬 Best Content Collection  ║
║  ⚡ Fast & Reliable              ║
║  ⭐ Save Favorites               ║
║  📊 Track Your Stats            ║
║                                   ║
╚══════════════════════════════╝

👇 Category choose karo:
"""

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    data = load_data()
    user_id = update.effective_user.id
    track_user(data, user_id)
    save_data(data)

    keyboard = []

    for cat, ids in data["categories"].items():
        keyboard.append([InlineKeyboardButton(f"📂 {cat} ({len(ids)})", callback_data=f"cat_{cat}")])

    # Special categories
    total = len(get_all_videos(data))
    keyboard.append([InlineKeyboardButton(f"🎲 Random ({total})", callback_data="cat_🎲 Random")])
    keyboard.append([InlineKeyboardButton(f"🆕 Latest ({total})", callback_data="cat_🆕 Latest")])
    keyboard.append([InlineKeyboardButton(f"🔥 Surprise", callback_data="cat_🔥 Surprise")])

    keyboard.append([InlineKeyboardButton("⭐ My Favorites", callback_data="show_favs")])
    keyboard.append([InlineKeyboardButton("📊 My Stats", callback_data="show_stats")])

    reply_markup = InlineKeyboardMarkup(keyboard)
    await update.message.reply_text(WELCOME_TEXT, reply_markup=reply_markup)

# ======================
# BUTTON HANDLERS
# ======================

async def button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data_str = query.data

    if data_str == "noop":
        return

    # --- Category Selection ---
    if data_str.startswith("cat_"):
        category = data_str[4:]
        context.user_data["category"] = category

        data = load_data()
        if category in data["categories"]:
            count = len(data["categories"][category])
        else:
            count = len(get_all_videos(data))

        await query.message.reply_text(
            f"📂 **{category}** selected ({count} files available)\n\n"
            f"Kitni files chahiye?\n"
            f"• Number bhejo: `5`\n"
            f"• Range bhejo: `8-15`\n"
            f"• Ya /all bhejo sab ke liye",
            parse_mode="Markdown"
        )
        return

    # --- Pagination ---
    if data_str.startswith("page_"):
        parts = data_str.split("_", 2)
        if len(parts) == 3:
            category = parts[1]
            page = int(parts[2])
            ids = context.user_data.get("current_ids", [])
            if ids:
                await send_page(update, context, ids, page, category)
        return

    # --- Save page to favorites ---
    if data_str.startswith("savepage_"):
        parts = data_str.split("_")
        if len(parts) >= 4:
            start_idx = int(parts[1])
            end_idx = int(parts[2])
            category = "_".join(parts[3:])
            ids = context.user_data.get("current_ids", [])
            page_ids = ids[start_idx:end_idx]

            user_id = str(update.effective_user.id)
            data = load_data()

            if user_id not in data["favorites"]:
                data["favorites"][user_id] = []

            added = 0
            for mid in page_ids:
                if mid not in data["favorites"][user_id]:
                    data["favorites"][user_id].append(mid)
                    added += 1

            save_data(data)
            await query.message.reply_text(f"⭐ {added} files favorites mein save ho gayi!")
        return

    # --- Show favorites ---
    if data_str == "show_favs":
        user_id = str(update.effective_user.id)
        data = load_data()
        favs = data.get("favorites", {}).get(user_id, [])

        if not favs:
            await query.message.reply_text("⭐ Tumhare koi favorites nahi hain abhi.\n\nVideos bhejwao aur ⭐ button se save karo!")
            return

        context.user_data["current_ids"] = favs
        context.user_data["current_category"] = "favorites"
        await send_page(update, context, favs, 0, "favorites")
        return

    # --- Show stats ---
    if data_str == "show_stats":
        await show_my_stats(update, context, from_button=True)
        return

# ======================
# NUMBER INPUT / /all
# ======================

async def all_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # Admin-only command
    if not is_admin(update.effective_user.id):
        await update.message.reply_text("🚫 /all command sirf admins ke liye hai.\n\nNumber ya range bhejo (e.g. `5` ya `1-10`)", parse_mode="Markdown")
        return

    if "category" not in context.user_data:
        await update.message.reply_text("❌ Pehle /start se category select karo.")
        return

    category = context.user_data["category"]
    data = load_data()

    if category in data["categories"]:
        count = len(data["categories"][category])
    else:
        count = len(get_all_videos(data))

    await send_category(update, context, category, count)
    context.user_data.pop("category", None)

async def send_posts(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if "category" not in context.user_data:
        return

    text = update.message.text.strip()
    user_id = update.effective_user.id
    category = context.user_data["category"]

    # --- Range input: "8-15" ---
    if "-" in text:
        parts = text.split("-")
        if len(parts) == 2:
            try:
                start_idx = int(parts[0].strip())
                end_idx = int(parts[1].strip())
            except ValueError:
                await update.message.reply_text("❌ Invalid range. Example: `8-15`", parse_mode="Markdown")
                return

            if start_idx <= 0 or end_idx <= 0:
                await update.message.reply_text("❌ Range 1 se start hoti hai. Example: `1-10`", parse_mode="Markdown")
                return

            if start_idx > end_idx:
                await update.message.reply_text(f"❌ Invalid range! {start_idx} > {end_idx}. Pehle chhota number phir bada. Example: `8-15`", parse_mode="Markdown")
                return

            data = load_data()
            all_vids = get_all_videos(data)

            if category in data["categories"]:
                cat_ids = data["categories"][category]
            elif category in ("🎲 Random", "🆕 Latest", "🔥 Surprise"):
                cat_ids = all_vids
            else:
                cat_ids = []

            total = len(cat_ids)
            if start_idx > total:
                await update.message.reply_text(f"❌ Sirf {total} files hain! Range `1-{total}` tak valid hai.", parse_mode="Markdown")
                return

            end_idx = min(end_idx, total)
            count = end_idx - start_idx + 1

            # Rate limit check
            allowed, remaining = check_daily_limit(data, user_id, count)
            if allowed == 0 and not is_admin(user_id):
                await update.message.reply_text(f"🚦 Aaj ka daily limit ({DAILY_LIMIT}) khatam! Kal aana 😊")
                return

            if allowed < count and not is_admin(user_id):
                await update.message.reply_text(f"🚦 Aaj sirf {remaining} files baaki. {allowed} bhej raha hoon.")
                count = allowed
                end_idx = start_idx + count - 1

            # Get the specific range (1-indexed to 0-indexed)
            ids = cat_ids[start_idx - 1 : end_idx]

            if not ids:
                await update.message.reply_text("❌ Is range mein koi content nahi hai.")
                return

            context.user_data["current_ids"] = ids
            context.user_data["current_category"] = category

            track_user(data, user_id)
            update_user_stats(data, user_id, category, len(ids))

            await send_page(update, context, ids, 0, category)
            context.user_data.pop("category", None)
            return

        else:
            await update.message.reply_text("❌ Invalid format. Number ya range bhejo (e.g. `5` ya `8-15`)", parse_mode="Markdown")
            return

    # --- Normal number input ---
    try:
        count = int(text)
    except ValueError:
        await update.message.reply_text("❌ Number ya range bhejo (e.g. `5` ya `8-15`)", parse_mode="Markdown")
        return

    if count <= 0:
        await update.message.reply_text("❌ 1 ya usse zyada number bhejo.")
        return

    # Max per request cap (not for admins)
    if not is_admin(user_id) and count > MAX_PER_REQUEST:
        await update.message.reply_text(f"⚠️ Ek baar mein max {MAX_PER_REQUEST} files bhej sakta hoon. {MAX_PER_REQUEST} bhej raha hoon.")
        count = MAX_PER_REQUEST

    # Rate limit check
    data = load_data()
    allowed, remaining = check_daily_limit(data, user_id, count)
    if allowed == 0:
        await update.message.reply_text(f"🚦 Aaj ka daily limit ({DAILY_LIMIT}) khatam! Kal aana 😊")
        return

    if allowed < count and not is_admin(user_id):
        await update.message.reply_text(f"🚦 Aaj sirf {remaining} files baaki. {allowed} bhej raha hoon.")
        count = allowed


    category = context.user_data["category"]
    await send_category(update, context, category, count)
    context.user_data.pop("category", None)

# ======================
# DIRECT CATEGORY COMMANDS
# ======================

async def make_direct_cmd(update, context, category):
    context.user_data["category"] = category
    data = load_data()
    count = len(data["categories"].get(category, []))
    await update.message.reply_text(
        f"📂 **{category}** ({count} files)\n\n"
        f"Kitni files chahiye?\n"
        f"• Number bhejo: `5`\n"
        f"• Range bhejo: `8-15`\n"
        f"• Ya /all bhejo sab ke liye",
        parse_mode="Markdown"
    )

async def solo(update, context): await make_direct_cmd(update, context, "Solo")
async def duo(update, context): await make_direct_cmd(update, context, "Duo")
async def spicy(update, context): await make_direct_cmd(update, context, "Spicy")

async def random_cmd(update, context):
    context.user_data["category"] = "🎲 Random"
    await update.message.reply_text(f"🎲 Kitni Random files chahiye? Number bhejo (max {MAX_PER_REQUEST})")

async def latest_cmd(update, context):
    context.user_data["category"] = "🆕 Latest"
    await update.message.reply_text(f"🆕 Kitni Latest files chahiye? Number bhejo (max {MAX_PER_REQUEST})")

async def surprise_cmd(update, context):
    context.user_data["category"] = "🔥 Surprise"
    await update.message.reply_text(f"🔥 Kitni Surprise files chahiye? Number bhejo (max {MAX_PER_REQUEST})")

# ======================
# FAVORITES COMMANDS
# ======================

async def favorites(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = str(update.effective_user.id)
    data = load_data()
    favs = data.get("favorites", {}).get(user_id, [])

    if not favs:
        await update.message.reply_text("⭐ Koi favorites nahi hain abhi.\n\nVideos bhejwao aur ⭐ button dabao!")
        return

    context.user_data["current_ids"] = favs
    context.user_data["current_category"] = "favorites"
    await update.message.reply_text(f"⭐ Tumhare {len(favs)} favorite files hain:")
    await send_page(update, context, favs, 0, "favorites")

async def clearfavs(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = str(update.effective_user.id)
    data = load_data()
    data["favorites"].pop(user_id, None)
    save_data(data)
    await update.message.reply_text("🗑️ Favorites cleared!")

# ======================
# /mystats COMMAND
# ======================

async def show_my_stats(update: Update, context: ContextTypes.DEFAULT_TYPE, from_button=False):
    user_id = str(update.effective_user.id)
    data = load_data()
    stats = data["user_stats"].get(user_id, {})

    total = stats.get("total_requests", 0)
    daily = stats.get("daily_count", 0)
    favs = len(data.get("favorites", {}).get(user_id, []))

    fav_cats = stats.get("fav_categories", {})
    top_cat = max(fav_cats, key=fav_cats.get) if fav_cats else "N/A"

    today_remaining = max(0, DAILY_LIMIT - daily)
    if is_admin(int(user_id)):
        limit_text = "♾️ Unlimited (Admin)"
        title_text = "📊 **Your Stats** 💎 Admin"
    else:
        limit_text = f"{today_remaining}/{DAILY_LIMIT}"
        title_text = "📊 **Your Stats**"

    text = (
        f"{title_text}\n"
        f"━━━━━━━━━━━━━━━\n"
        f"📨 Total Requests: **{total}**\n"
        f"📅 Today's Usage: **{daily}** files\n"
        f"🚦 Remaining Today: **{limit_text}**\n"
        f"⭐ Favorites: **{favs}** files\n"
        f"💎 Top Category: **{top_cat}**\n"
        f"━━━━━━━━━━━━━━━"
    )

    if from_button:
        await update.callback_query.message.reply_text(text, parse_mode="Markdown")
    else:
        await update.message.reply_text(text, parse_mode="Markdown")

async def mystats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await show_my_stats(update, context, from_button=False)

# ======================
# /clear COMMAND
# ======================

async def clear(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    sent = context.user_data.get("sent_messages", [])

    deleted = 0
    for msg_id in sent:
        try:
            await context.bot.delete_message(chat_id=chat_id, message_id=msg_id)
            deleted += 1
        except Exception:
            pass  # Message already deleted or too old (>48h)

    context.user_data.clear()
    await update.message.reply_text(f"🧹 {deleted} messages clear ho gayi!\n/start se dobara shuru karo.")

# ======================
# /help COMMAND
# ======================

HELP_TEXT = """
🤖 **SmartBot — Help**
━━━━━━━━━━━━━━━━━━━

**📂 Browse Content:**
/start — Categories dekhein
/solo — Solo content
/duo — Duo content
/spicy — Spicy content
/random — Random files
/latest — Latest files
/surprise — Surprise pick!

**⭐ Favorites:**
/favorites — Saved favorites
/clearfavs — Clear favorites

**📊 Stats:**
/mystats — Your usage stats

**🔧 Other:**
/clear — Bhejji files chat se delete karo
/help — Ye message

━━━━━━━━━━━━━━━━━━━
"""

ADMIN_HELP_TEXT = """
👑 **Admin Commands:**
━━━━━━━━━━━━━━━━━━━
/all — 💎 Sab files bhejo (admin only)
/add `<category>` `<id1>` `<id2>` ... — Add video IDs
/addrange `<category>` `<start>` `<end>` — Add range of IDs
/remove `<category>` `<id>` — Remove a video ID
/addcategory `<name>` — New category banao
/removecategory `<name>` — Category delete karo
/botstats — Bot statistics
/broadcast `<message>` — Sabko message bhejo
━━━━━━━━━━━━━━━━━━━
"""

async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = HELP_TEXT
    if is_admin(update.effective_user.id):
        text += ADMIN_HELP_TEXT
    await update.message.reply_text(text, parse_mode="Markdown")

# =============================
# ADMIN COMMANDS
# =============================

async def admin_check(update):
    if not is_admin(update.effective_user.id):
        await update.message.reply_text("🚫 Ye command sirf admins ke liye hai.")
        return False
    return True

# /add Solo 45 46 47
async def add_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await admin_check(update):
        return

    args = context.args
    if len(args) < 2:
        await update.message.reply_text("Usage: /add <category> <id1> <id2> ...\nExample: /add Solo 45 46 47")
        return

    category = args[0]
    data = load_data()

    if category not in data["categories"]:
        await update.message.reply_text(f"❌ Category '{category}' nahi mili.\n\nAvailable: {', '.join(data['categories'].keys())}\n\nNayi banane ke liye: /addcategory {category}")
        return

    try:
        new_ids = [int(x) for x in args[1:]]
    except ValueError:
        await update.message.reply_text("❌ Sirf numbers bhejo IDs ke liye.")
        return

    added = 0
    for mid in new_ids:
        if mid not in data["categories"][category]:
            data["categories"][category].append(mid)
            added += 1

    save_data(data)
    total = len(data["categories"][category])
    await update.message.reply_text(f"✅ {added} videos added to **{category}**!\n📊 Total in {category}: {total}", parse_mode="Markdown")

# /addrange Solo 45 54
async def addrange_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await admin_check(update):
        return

    args = context.args
    if len(args) != 3:
        await update.message.reply_text("Usage: /addrange <category> <start_id> <end_id>\nExample: /addrange Solo 45 54")
        return

    category = args[0]
    data = load_data()

    if category not in data["categories"]:
        await update.message.reply_text(f"❌ Category '{category}' nahi mili.\n\nPehle banao: /addcategory {category}")
        return

    try:
        start_id = int(args[1])
        end_id = int(args[2])
    except ValueError:
        await update.message.reply_text("❌ Start aur End sirf numbers hone chahiye.")
        return

    if start_id > end_id:
        start_id, end_id = end_id, start_id

    added = 0
    for mid in range(start_id, end_id + 1):
        if mid not in data["categories"][category]:
            data["categories"][category].append(mid)
            added += 1

    save_data(data)
    total = len(data["categories"][category])
    await update.message.reply_text(
        f"✅ {added} videos added to **{category}**! (IDs {start_id} to {end_id})\n📊 Total in {category}: {total}",
        parse_mode="Markdown"
    )

# /remove Solo 45
async def remove_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await admin_check(update):
        return

    args = context.args
    if len(args) < 2:
        await update.message.reply_text("Usage: /remove <category> <id1> <id2> ...\nExample: /remove Solo 45 46")
        return

    category = args[0]
    data = load_data()

    if category not in data["categories"]:
        await update.message.reply_text(f"❌ Category '{category}' nahi mili.")
        return

    try:
        remove_ids = [int(x) for x in args[1:]]
    except ValueError:
        await update.message.reply_text("❌ Sirf numbers bhejo IDs ke liye.")
        return

    removed = 0
    for mid in remove_ids:
        if mid in data["categories"][category]:
            data["categories"][category].remove(mid)
            removed += 1

    save_data(data)
    total = len(data["categories"][category])
    await update.message.reply_text(f"🗑️ {removed} videos removed from **{category}**!\n📊 Remaining in {category}: {total}", parse_mode="Markdown")

# /addcategory NewCategory
async def addcategory_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await admin_check(update):
        return

    args = context.args
    if len(args) != 1:
        await update.message.reply_text("Usage: /addcategory <name>\nExample: /addcategory Threesome")
        return

    name = args[0]
    data = load_data()

    if name in data["categories"]:
        await update.message.reply_text(f"⚠️ Category '{name}' already exists!")
        return

    data["categories"][name] = []
    save_data(data)
    await update.message.reply_text(f"✅ Category **{name}** created!\n\nAb videos add karo: /add {name} <id1> <id2> ...", parse_mode="Markdown")

# /removecategory OldCategory
async def removecategory_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await admin_check(update):
        return

    args = context.args
    if len(args) != 1:
        await update.message.reply_text("Usage: /removecategory <name>")
        return

    name = args[0]
    data = load_data()

    if name not in data["categories"]:
        await update.message.reply_text(f"❌ Category '{name}' nahi mili.")
        return

    count = len(data["categories"][name])
    del data["categories"][name]
    save_data(data)
    await update.message.reply_text(f"🗑️ Category **{name}** deleted! ({count} videos the)", parse_mode="Markdown")

# /botstats
async def botstats_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await admin_check(update):
        return

    data = load_data()
    total_users = len(data.get("known_users", []))
    total_videos = len(get_all_videos(data))
    total_cats = len(data["categories"])

    total_requests = sum(s.get("total_requests", 0) for s in data["user_stats"].values())

    cat_info = ""
    for cat, ids in data["categories"].items():
        cat_info += f"  📂 {cat}: {len(ids)} videos\n"

    text = (
        f"👑 **Bot Statistics**\n"
        f"━━━━━━━━━━━━━━━━━\n"
        f"👥 Total Users: **{total_users}**\n"
        f"🎬 Total Videos: **{total_videos}**\n"
        f"📁 Categories: **{total_cats}**\n"
        f"📨 Total Requests: **{total_requests}**\n"
        f"━━━━━━━━━━━━━━━━━\n"
        f"\n**Categories:**\n{cat_info}"
    )

    await update.message.reply_text(text, parse_mode="Markdown")

# /broadcast Hello everyone!
async def broadcast_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await admin_check(update):
        return

    if not context.args:
        await update.message.reply_text("Usage: /broadcast <message>")
        return

    message = " ".join(context.args)
    data = load_data()
    users = data.get("known_users", [])

    sent = 0
    failed = 0
    for uid in users:
        try:
            await context.bot.send_message(chat_id=uid, text=f"📢 **Announcement**\n\n{message}", parse_mode="Markdown")
            sent += 1
        except Exception:
            failed += 1

    await update.message.reply_text(f"📢 Broadcast done!\n✅ Sent: {sent}\n❌ Failed: {failed}")

# ======================
# RUN BOT
# ======================

# Fix event loop for Python 3.12+
try:
    asyncio.get_event_loop()
except RuntimeError:
    asyncio.set_event_loop(asyncio.new_event_loop())

keep_alive()

app_bot = ApplicationBuilder().token(TOKEN).build()

# User commands
app_bot.add_handler(CommandHandler("start", start))
app_bot.add_handler(CommandHandler("solo", solo))
app_bot.add_handler(CommandHandler("duo", duo))
app_bot.add_handler(CommandHandler("spicy", spicy))
app_bot.add_handler(CommandHandler("random", random_cmd))
app_bot.add_handler(CommandHandler("latest", latest_cmd))
app_bot.add_handler(CommandHandler("surprise", surprise_cmd))
app_bot.add_handler(CommandHandler("all", all_cmd))
app_bot.add_handler(CommandHandler("favorites", favorites))
app_bot.add_handler(CommandHandler("clearfavs", clearfavs))
app_bot.add_handler(CommandHandler("mystats", mystats))
app_bot.add_handler(CommandHandler("clear", clear))
app_bot.add_handler(CommandHandler("help", help_cmd))

# Admin commands
app_bot.add_handler(CommandHandler("add", add_cmd))
app_bot.add_handler(CommandHandler("addrange", addrange_cmd))
app_bot.add_handler(CommandHandler("remove", remove_cmd))
app_bot.add_handler(CommandHandler("addcategory", addcategory_cmd))
app_bot.add_handler(CommandHandler("removecategory", removecategory_cmd))
app_bot.add_handler(CommandHandler("botstats", botstats_cmd))
app_bot.add_handler(CommandHandler("broadcast", broadcast_cmd))

# Button & text handlers
app_bot.add_handler(CallbackQueryHandler(button_handler))
app_bot.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, send_posts))

print("🤖 SmartBot running...")
app_bot.run_polling()