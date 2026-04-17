import os
import sys
import json
import asyncio
import threading
import random
from datetime import datetime, date

from flask import Flask
from dotenv import load_dotenv

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, MessageOriginChannel
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

# --- Free vs Premium Limits ---
FREE_DAILY_LIMIT = 30             # Free users: 30 files/day
FREE_MAX_PER_REQUEST = 30         # Allow up to limit per request so pagination works
# Premium + Admin = UNLIMITED (no cap)

# ======================
# DATA HELPERS
# ======================

DEFAULT_DATA = {
    "categories": {},
    "favorites": {},
    "user_stats": {},
    "premium_users": [],
    "premium_categories": [],
    "known_users": []
}

def load_data():
    if not os.path.exists(DATA_FILE):
        save_data(DEFAULT_DATA)
        return DEFAULT_DATA.copy()
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    # Ensure all keys exist (for old data.json files)
    for key, val in DEFAULT_DATA.items():
        if key not in data:
            data[key] = val
    return data

def save_data(data):
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)

def is_admin(user_id):
    return user_id in ADMIN_IDS

def is_premium(data, user_id):
    """Check if user is premium. Admins are always premium."""
    if is_admin(user_id):
        return True
    return user_id in data.get("premium_users", [])

def is_premium_category(data, category_name):
    """Check if category is in premium list."""
    return category_name in data.get("premium_categories", [])

def get_max_per_request(data, user_id):
    """Get max files per request based on user tier."""
    if is_admin(user_id) or is_premium(data, user_id):
        return 999999  # Unlimited for premium + admin
    return FREE_MAX_PER_REQUEST

def get_daily_limit(data, user_id):
    """Get daily limit based on user tier."""
    if is_admin(user_id) or is_premium(data, user_id):
        return 999999  # Unlimited for premium + admin
    return FREE_DAILY_LIMIT

def get_all_videos(data):
    all_vids = []
    for ids in data["categories"].values():
        all_vids.extend(ids)
    return all_vids

def get_accessible_categories(data, user_id):
    """Return categories the user can access."""
    result = {}
    for cat, ids in data["categories"].items():
        if is_premium_category(data, cat) and not is_premium(data, user_id):
            continue  # Skip premium categories for free users
        result[cat] = ids
    return result

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
    # Ensure premium_users list exists
    if "premium_users" not in data:
        data["premium_users"] = []
    return data

def check_daily_limit(data, user_id, count):
    """Returns (allowed_count, remaining). Admins get unlimited."""
    daily_limit = get_daily_limit(data, user_id)
    if is_admin(user_id):
        return count, 999999

    uid = str(user_id)
    stats = data["user_stats"].get(uid, {})
    today = str(date.today())

    if stats.get("last_date") != today:
        stats["daily_count"] = 0
        stats["last_date"] = today

    used = stats.get("daily_count", 0)
    remaining = max(0, daily_limit - used)
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

def get_user_tier_text(data, user_id):
    """Return tier emoji + text for display."""
    if is_admin(user_id):
        return "👑 Admin"
    if is_premium(data, user_id):
        return "💎 Premium"
    return "🆓 Free"

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

async def send_page(update, context, msg_ids, page, category, send_all=False):
    """Forward a single page of files and show pagination buttons."""
    total = len(msg_ids)
    if send_all:
        total_pages = 1
        page = 0
        start = 0
        end = total
        page_ids = msg_ids
    else:
        total_pages = max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)
        page = max(0, min(page, total_pages - 1))
        start = page * PAGE_SIZE
        end = min(start + PAGE_SIZE, total)
        page_ids = msg_ids[start:end]

    chat_id = update.effective_chat.id
    user_id = str(update.effective_user.id)
    
    try:
        data = load_data()
        favs = data.get("favorites", {}).get(user_id, [])
    except:
        favs = []

    # Track sent message IDs for /clear
    if "sent_messages" not in context.user_data:
        context.user_data["sent_messages"] = []

    # Send files first
    for msg_id in page_ids:
        try:
            # Inline button for specific message
            is_fav = msg_id in favs
            btn_text = "❌ Remove Favorite" if is_fav else "⭐ Save to Favorites"
            btn_data = f"unfav_{msg_id}" if is_fav else f"fav_{msg_id}"
            kb = InlineKeyboardMarkup([[InlineKeyboardButton(btn_text, callback_data=btn_data)]])
            
            # Using copy_message instead of forward so we can attach custom keyboard
            fwd = await context.bot.copy_message(
                chat_id=chat_id,
                from_chat_id=CHANNEL_ID,
                message_id=msg_id,
                reply_markup=kb
            )
            context.user_data["sent_messages"].append(fwd.message_id)
            if send_all and len(page_ids) > 5:
                await asyncio.sleep(0.1)
        except Exception:
            pass  # Skip deleted/inaccessible messages

    # Build pagination buttons
    keyboard = []
    if not send_all:
        buttons = []
        if page > 0:
            buttons.append(InlineKeyboardButton("⬅️ Prev", callback_data=f"page_{category}_{page-1}"))
        buttons.append(InlineKeyboardButton(f"📄 {page+1}/{total_pages}", callback_data="noop"))
        if page < total_pages - 1:
            buttons.append(InlineKeyboardButton("Next ➡️", callback_data=f"page_{category}_{page+1}"))
        if buttons:
            keyboard.append(buttons)

    # Send info + buttons AFTER the files
    if keyboard:
        info_msg = await context.bot.send_message(
            chat_id=chat_id,
            text=f"✅ Sent {len(page_ids)} files ({start+1}-{end} of {total})",
            reply_markup=InlineKeyboardMarkup(keyboard)
        )
    else:
        info_msg = await context.bot.send_message(
            chat_id=chat_id,
            text=f"✅ Sent {len(page_ids)} files (All)"
        )
    context.user_data["sent_messages"].append(info_msg.message_id)

async def send_category(update, context, category, count, send_all=False):
    """Prepare the message IDs for a category and send the first page."""
    data = load_data()
    all_vids = get_all_videos(data)
    user_id = update.effective_user.id

    # Premium category access check
    if is_premium_category(data, category) and not is_premium(data, user_id):
        await update.message.reply_text(
            "🔒 **Premium Content!**\n\n"
            "Ye category sirf Premium users ke liye hai.\n\n"
            "💎 Premium benefits:\n"
            f"• 📂 Premium categories access\n"
            f"• 📤 Unlimited files per request\n"
            f"• 📅 Unlimited daily access\n"
            "• 🔓 /all command access\n\n"
            "Admin se contact karo premium lene ke liye! 🚀",
            parse_mode="Markdown"
        )
        return

    if category == "🎲 Random":
        # For random, only use accessible categories
        accessible = get_accessible_categories(data, user_id)
        pool = []
        for ids in accessible.values():
            pool.extend(ids)
        ids = random.sample(pool, min(count, len(pool)))
    elif category == "🆕 Latest":
        accessible = get_accessible_categories(data, user_id)
        pool = []
        for ids_list in accessible.values():
            pool.extend(ids_list)
        ids = sorted(pool, reverse=True)[:count]
    elif category == "🔥 Surprise":
        accessible = get_accessible_categories(data, user_id)
        cats = list(accessible.keys())
        if cats:
            rand_cat = random.choice(cats)
            pool = accessible[rand_cat]
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

    await send_page(update, context, ids, 0, category, send_all=send_all)

# ======================
# /start COMMAND
# ======================

WELCOME_FREE = """
╔══════════════════════════════╗
║    🤖 SmartBot — Free Tier   
╠══════════════════════════════╣
║                              
║  🎬 Content Collection       
║  ⚡ Fast & Reliable          
║  ⭐ Save Favorites           
║  📊 Track Your Stats         
║                              
║  💎 /upgrade for Premium!    
║                              
╚══════════════════════════════╝

👇 Category choose karo:
"""

WELCOME_PREMIUM = """
╔══════════════════════════════╗
║  🤖 SmartBot — 💎 Premium   
╠══════════════════════════════╣
║                              
║  🎬 ALL Content Unlocked     
║  ⚡ Fast & Reliable          
║  📤 10 Files Per Request     
║  🔓 /all Command Access      
║  ⭐ Save Favorites           
║  📊 Track Your Stats         
║                              
╚══════════════════════════════╝

👇 Category choose karo:
"""

WELCOME_ADMIN = """
╔══════════════════════════════╗
║  🤖 SmartBot — 👑 Admin      
╠══════════════════════════════╣
║                              
║  🎬 ALL Content Unlocked     
║  ⚡ Unlimited Access         
║  🔧 Full Admin Controls      
║                              
╚══════════════════════════════╝

👇 Category choose karo:
"""

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    data = load_data()
    user_id = update.effective_user.id
    track_user(data, user_id)
    save_data(data)

    # Select welcome text based on tier
    if is_admin(user_id):
        welcome = WELCOME_ADMIN
    elif is_premium(data, user_id):
        welcome = WELCOME_PREMIUM
    else:
        welcome = WELCOME_FREE

    keyboard = []

    accessible = get_accessible_categories(data, user_id)

    # Show accessible categories
    for cat, ids in accessible.items():
        if is_premium_category(data, cat):
            keyboard.append([InlineKeyboardButton(f"💎 {cat} ({len(ids)})", callback_data=f"cat_{cat}")])
        else:
            keyboard.append([InlineKeyboardButton(f"📂 {cat} ({len(ids)})", callback_data=f"cat_{cat}")])

    # Show locked premium categories for free users (greyed out / teaser)
    if not is_premium(data, user_id):
        for cat, ids in data["categories"].items():
            if is_premium_category(data, cat):
                keyboard.append([InlineKeyboardButton(f"🔒 {cat} ({len(ids)}) — Premium Only", callback_data=f"cat_{cat}")])

    # Special categories
    accessible_vids = []
    for ids_list in accessible.values():
        accessible_vids.extend(ids_list)
    total = len(accessible_vids)

    keyboard.append([InlineKeyboardButton(f"🎲 Random ({total})", callback_data="cat_🎲 Random")])
    keyboard.append([InlineKeyboardButton(f"🆕 Latest ({total})", callback_data="cat_🆕 Latest")])
    keyboard.append([InlineKeyboardButton(f"🔥 Surprise", callback_data="cat_🔥 Surprise")])

    keyboard.append([InlineKeyboardButton("⭐ My Favorites", callback_data="show_favs")])
    keyboard.append([InlineKeyboardButton("📊 My Stats", callback_data="show_stats")])

    # Upgrade button for free users
    if not is_premium(data, user_id) and not is_admin(user_id):
        keyboard.append([InlineKeyboardButton("💎 Upgrade to Premium!", callback_data="show_upgrade")])

    reply_markup = InlineKeyboardMarkup(keyboard)
    await update.message.reply_text(welcome, reply_markup=reply_markup)

# ======================
# PREVIEW MODE (CAROUSEL)
# ======================

async def show_preview_item(update, context, category, index):
    """Send one file with carousel navigation buttons (Preview Mode)."""
    query = update.callback_query
    data = load_data()
    user_id = update.effective_user.id
    user_id_str = str(user_id)

    # Premium check
    if is_premium_category(data, category) and not is_premium(data, user_id):
        await query.answer("🔒 Premium content! /upgrade se access pao.", show_alert=True)
        return

    # Resolve IDs for the category
    if category == "🎲 Random":
        accessible = get_accessible_categories(data, user_id)
        ids = []
        for v in accessible.values():
            ids.extend(v)
        # Use a seeded shuffle so Prev/Next is consistent within a session
        session_ids = context.user_data.get("preview_shuffled_ids", None)
        if session_ids is None or context.user_data.get("preview_category") != category:
            random.shuffle(ids)
            context.user_data["preview_shuffled_ids"] = ids
            context.user_data["preview_category"] = category
        else:
            ids = session_ids
    elif category == "🆕 Latest":
        accessible = get_accessible_categories(data, user_id)
        ids = []
        for v in accessible.values():
            ids.extend(v)
        ids = sorted(ids, reverse=True)
    elif category == "🔥 Surprise":
        accessible = get_accessible_categories(data, user_id)
        cats = list(accessible.keys())
        if cats:
            session_cat = context.user_data.get("surprise_cat")
            if session_cat not in accessible:
                session_cat = random.choice(cats)
                context.user_data["surprise_cat"] = session_cat
            ids = accessible[session_cat]
        else:
            ids = []
    elif category in data["categories"]:
        ids = data["categories"][category]
    else:
        ids = []

    if not ids:
        await query.answer("❌ Is category mein koi content nahi!", show_alert=True)
        return

    total = len(ids)
    index = max(0, min(index, total - 1))
    msg_id = ids[index]

    # Favorites check
    favs = data.get("favorites", {}).get(user_id_str, [])
    is_fav = msg_id in favs

    # --- Build keyboard ---
    nav_row = []
    if index > 0:
        nav_row.append(InlineKeyboardButton("⬅️ Prev", callback_data=f"mp|{category}|{index - 1}"))
    nav_row.append(InlineKeyboardButton(f"📍 {index + 1}/{total}", callback_data="noop"))
    if index < total - 1:
        nav_row.append(InlineKeyboardButton("Next ➡️", callback_data=f"mp|{category}|{index + 1}"))

    fav_text = "❌ Unsave" if is_fav else "⭐ Save"
    fav_cb = f"unfav_{msg_id}" if is_fav else f"fav_{msg_id}"
    action_row = [
        InlineKeyboardButton(fav_text, callback_data=fav_cb),
        InlineKeyboardButton("❌ Exit", callback_data="exit_preview"),
    ]

    keyboard = InlineKeyboardMarkup([nav_row, action_row])
    chat_id = query.message.chat_id
    old_msg_id = query.message.message_id

    try:
        await context.bot.copy_message(
            chat_id=chat_id,
            from_chat_id=CHANNEL_ID,
            message_id=msg_id,
            reply_markup=keyboard,
        )
        # Update stats silently
        track_user(data, user_id)
        update_user_stats(data, user_id, category, 1)
        # Delete previous preview card to keep chat clean
        try:
            await context.bot.delete_message(chat_id=chat_id, message_id=old_msg_id)
        except Exception:
            pass
    except Exception as e:
        await query.answer(f"❌ Error: {e}", show_alert=True)

# ======================
# BUTTON HANDLERS
# ======================

async def button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data_str = query.data

    if data_str == "noop":
        return

    # --- Category Selection → Mode Chooser ---
    if data_str.startswith("cat_"):
        category = data_str[4:]
        data = load_data()
        user_id = update.effective_user.id

        # Premium category check
        if is_premium_category(data, category) and not is_premium(data, user_id):
            await query.message.reply_text(
                "🔒 **Premium Content!**\n\n"
                "Ye category sirf 💎 Premium users ke liye hai.\n\n"
                "Premium benefits:\n"
                f"• 📂 Premium exclusive categories\n"
                f"• 📤 Unlimited files per request (free: {FREE_MAX_PER_REQUEST})\n"
                f"• 📅 Unlimited daily access (free: {FREE_DAILY_LIMIT}/day)\n"
                "• 🔓 /all command — sab files ek sath!\n\n"
                "Admin se contact karo premium ke liye! 🚀",
                parse_mode="Markdown"
            )
            return

        if category in data["categories"]:
            count = len(data["categories"][category])
        else:
            accessible = get_accessible_categories(data, user_id)
            count = sum(len(v) for v in accessible.values())

        # Show mode selection
        mode_keyboard = InlineKeyboardMarkup([
            [
                InlineKeyboardButton("🖼️ Preview Mode", callback_data=f"mp|{category}|0"),
                InlineKeyboardButton("⚡ Direct Mode", callback_data=f"md|{category}"),
            ]
        ])
        await query.message.reply_text(
            f"📂 **{category}** — {count} files\n\n"
            f"🖼️ **Preview** — Ek ek karke dekho, jo pasand aaye save karo\n"
            f"⚡ **Direct** — Number type karo, seedha files aao",
            parse_mode="Markdown",
            reply_markup=mode_keyboard,
        )
        return

    # --- Direct Mode: ask for count ---
    if data_str.startswith("md|"):
        category = data_str[3:]
        context.user_data["category"] = category
        data = load_data()
        user_id = update.effective_user.id

        if category in data["categories"]:
            count = len(data["categories"][category])
        else:
            accessible = get_accessible_categories(data, user_id)
            count = sum(len(v) for v in accessible.values())

        max_req = get_max_per_request(data, user_id)

        tier_info = ""
        if is_admin(user_id):
            tier_info = "👑 Admin — Unlimited access\n"
        elif is_premium(data, user_id):
            tier_info = f"💎 Premium — Max {max_req} per request\n"
        else:
            tier_info = f"🆓 Free — Max {max_req} per request\n"

        await query.message.reply_text(
            f"⚡ **Direct Mode — {category}** ({count} files)\n"
            f"{tier_info}\n"
            f"Kitni files chahiye?\n"
            f"• Number bhejo: `5`\n"
            f"• Range bhejo: `8-15`\n"
            f"• Ya /all bhejo sab ke liye 🔥",
            parse_mode="Markdown",
        )
        return

    # --- Preview Mode: carousel ---
    if data_str.startswith("mp|"):
        parts = data_str.split("|", 2)
        if len(parts) == 3:
            category = parts[1]
            index = int(parts[2])
            await show_preview_item(update, context, category, index)
        return

    # --- Exit Preview ---
    if data_str == "exit_preview":
        try:
            await query.message.delete()
        except Exception:
            pass
        # Clear preview session data
        context.user_data.pop("preview_shuffled_ids", None)
        context.user_data.pop("preview_category", None)
        context.user_data.pop("surprise_cat", None)
        await query.answer("Preview mode exit ho gaya! /start se dobara browse karo.", show_alert=False)
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

    # --- Add INDIVIDUAL to Favorites ---
    if data_str.startswith("fav_"):
        try:
            msg_id = int(data_str.split("_")[1])
            user_id = str(update.effective_user.id)
            data = load_data()
            
            if user_id not in data["favorites"]:
                data["favorites"][user_id] = []
                
            if msg_id not in data["favorites"][user_id]:
                data["favorites"][user_id].append(msg_id)
                save_data(data)
                
                # Update button
                new_btn = InlineKeyboardMarkup([[
                    InlineKeyboardButton("❌ Remove Favorite", callback_data=f"unfav_{msg_id}")
                ]])
                await query.edit_message_reply_markup(reply_markup=new_btn)
            else:
                await query.answer("Already in favorites!")
        except Exception:
            pass
        return

    # --- Remove INDIVIDUAL from Favorites ---
    if data_str.startswith("unfav_"):
        try:
            msg_id = int(data_str.split("_")[1])
            user_id = str(update.effective_user.id)
            data = load_data()
            
            if user_id in data["favorites"] and msg_id in data["favorites"][user_id]:
                data["favorites"][user_id].remove(msg_id)
                save_data(data)
                
                new_btn = InlineKeyboardMarkup([[
                    InlineKeyboardButton("⭐ Save to Favorites", callback_data=f"fav_{msg_id}")
                ]])
                await query.edit_message_reply_markup(reply_markup=new_btn)
            else:
                await query.answer("Not in favorites!")
        except Exception:
            pass
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

    # --- Show upgrade info ---
    if data_str == "show_upgrade":
        await show_upgrade_info(update, context, from_button=True)
        return

# ======================
# UPGRADE INFO
# ======================

async def show_upgrade_info(update, context, from_button=False):
    data = load_data()
    user_id = update.effective_user.id

    if is_premium(data, user_id):
        text = (
            "💎 **You're Already Premium!**\n"
            "━━━━━━━━━━━━━━━━━━━\n\n"
            "Tumhare paas already premium access hai! Enjoy karo! 🎉"
        )
    else:
        text = (
            "💎 **Upgrade to Premium!**\n"
            "━━━━━━━━━━━━━━━━━━━\n\n"
            "🆓 **Free Tier:**\n"
            f"  • {FREE_MAX_PER_REQUEST} files per request\n"
            f"  • {FREE_DAILY_LIMIT} files per day\n"
            "  • Basic categories only\n"
            "  • ❌ No /all command\n\n"
            "💎 **Premium Tier:**\n"
            f"  • ♾️ Unlimited files per request\n"
            f"  • ♾️ Unlimited files per day\n"
            "  • 🔓 ALL categories (Premium 🔥 included!)\n"
            "  • ✅ /all command — sab files ek sath!\n"
            "  • ⚡ Priority support\n\n"
            "━━━━━━━━━━━━━━━━━━━\n"
            "📩 **Premium lene ke liye Admin se contact karo!**"
        )

    if from_button:
        await update.callback_query.message.reply_text(text, parse_mode="Markdown")
    else:
        await update.message.reply_text(text, parse_mode="Markdown")

async def upgrade_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await show_upgrade_info(update, context, from_button=False)

# ======================
# NUMBER INPUT / /all
# ======================

async def all_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    data = load_data()
    user_id = update.effective_user.id

    # Premium + Admin can use /all
    if not is_premium(data, user_id):
        await update.message.reply_text(
            "🔒 **/all sirf 💎 Premium aur 👑 Admin ke liye hai!**\n\n"
            f"Free users max {FREE_MAX_PER_REQUEST} files per request bhej sakte hain.\n\n"
            "💎 /upgrade se premium benefits dekho!",
            parse_mode="Markdown"
        )
        return

    if "category" not in context.user_data:
        await update.message.reply_text("❌ Pehle /start se category select karo.")
        return

    category = context.user_data["category"]
    data = load_data()

    if category in data["categories"]:
        count = len(data["categories"][category])
    else:
        accessible = get_accessible_categories(data, user_id)
        count = sum(len(v) for v in accessible.values())

    await send_category(update, context, category, count, send_all=True)
    context.user_data.pop("category", None)

async def send_posts(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if "category" not in context.user_data:
        return

    text = update.message.text.strip()
    user_id = update.effective_user.id
    category = context.user_data["category"]
    data = load_data()

    max_per_request = get_max_per_request(data, user_id)

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

            all_vids = get_all_videos(data)

            if category in data["categories"]:
                cat_ids = data["categories"][category]
            elif category in ("🎲 Random", "🆕 Latest", "🔥 Surprise"):
                accessible = get_accessible_categories(data, user_id)
                cat_ids = []
                for ids_list in accessible.values():
                    cat_ids.extend(ids_list)
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
                daily_limit = get_daily_limit(data, user_id)
                await update.message.reply_text(f"🚦 Aaj ka daily limit ({daily_limit}) khatam! Kal aana 😊")
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

    # Max per request cap based on tier
    if count > max_per_request:
        tier_name = get_user_tier_text(data, user_id)
        await update.message.reply_text(
            f"⚠️ {tier_name} — max {max_per_request} files per request.\n"
            f"{max_per_request} Sending..."
        )
        count = max_per_request

    # Rate limit check
    allowed, remaining = check_daily_limit(data, user_id, count)
    if allowed == 0:
        daily_limit = get_daily_limit(data, user_id)
        await update.message.reply_text(f"🚦 Aaj ka daily limit ({daily_limit}) khatam! Kal aana 😊")
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
    user_id = update.effective_user.id

    # Premium category check
    if is_premium_category(data, category) and not is_premium(data, user_id):
        await update.message.reply_text(
            f"🔒 **{category}** sirf 💎 Premium users ke liye hai!\n\n"
            "💎 /upgrade se premium benefits dekho!",
            parse_mode="Markdown"
        )
        context.user_data.pop("category", None)
        return

    count = len(data["categories"].get(category, []))
    max_req = get_max_per_request(data, user_id)

    all_text = "• Ya /all bhejo sab ke liye 🔥\n"

    await update.message.reply_text(
        f"📂 **{category}** ({count} files)\n\n"
        f"Kitni files chahiye? (max {max_req})\n"
        f"• Number bhejo: `5`\n"
        f"• Range bhejo: `8-15`\n"
        f"{all_text}",
        parse_mode="Markdown"
    )

async def solo(update, context): await make_direct_cmd(update, context, "Solo")
async def duo(update, context): await make_direct_cmd(update, context, "Duo")
async def spicy(update, context): await make_direct_cmd(update, context, "Spicy")

async def random_cmd(update, context):
    data = load_data()
    max_req = get_max_per_request(data, update.effective_user.id)
    context.user_data["category"] = "🎲 Random"
    await update.message.reply_text(f"🎲 Kitni Random files chahiye? Number bhejo (max {max_req})")

async def latest_cmd(update, context):
    data = load_data()
    max_req = get_max_per_request(data, update.effective_user.id)
    context.user_data["category"] = "🆕 Latest"
    await update.message.reply_text(f"🆕 Kitni Latest files chahiye? Number bhejo (max {max_req})")

async def surprise_cmd(update, context):
    data = load_data()
    max_req = get_max_per_request(data, update.effective_user.id)
    context.user_data["category"] = "🔥 Surprise"
    await update.message.reply_text(f"🔥 Kitni Surprise files chahiye? Number bhejo (max {max_req})")

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

    tier = get_user_tier_text(data, int(user_id))
    daily_limit = get_daily_limit(data, int(user_id))
    max_req = get_max_per_request(data, int(user_id))

    if is_admin(int(user_id)):
        limit_text = "♾️ Unlimited (Admin)"
    else:
        today_remaining = max(0, daily_limit - daily)
        limit_text = f"{today_remaining}/{daily_limit}"

    text = (
        f"📊 **Your Stats** {tier}\n"
        f"━━━━━━━━━━━━━━━\n"
        f"📨 Total Requests: **{total}**\n"
        f"📅 Today's Usage: **{daily}** files\n"
        f"🚦 Remaining Today: **{limit_text}**\n"
        f"📤 Max Per Request: **{max_req}**\n"
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
# /search COMMAND
# ======================

async def search_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("Usage: /search <keyword>\nExample: /search solo")
        return

    query = " ".join(context.args).lower()
    data = load_data()
    user_id = update.effective_user.id

    results = []
    for cat, ids in data["categories"].items():
        if query in cat.lower():
            locked = is_premium_category(data, cat) and not is_premium(data, user_id)
            if locked:
                results.append(f"🔒 {cat} ({len(ids)} files) — Premium Only")
            else:
                results.append(f"📂 {cat} ({len(ids)} files)")

    if not results:
        await update.message.reply_text(f"❌ \"{query}\" se match koi category nahi mili.")
        return

    text = f"🔍 **Search Results for \"{query}\":**\n\n" + "\n".join(results)
    await update.message.reply_text(text, parse_mode="Markdown")

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
/search — 🔍 Category search karo

**⭐ Favorites:**
/favorites — Saved favorites
/clearfavs — Clear favorites

**📊 Stats & Info:**
/mystats — Your usage stats
/upgrade — 💎 Premium benefits dekho

**🔧 Other:**
/clear — Bhejji files chat se delete karo
/help — Ye message

━━━━━━━━━━━━━━━━━━━
"""

PREMIUM_HELP_TEXT = """
💎 **Premium Commands:**
━━━━━━━━━━━━━━━━━━━
/all — 🔥 Sab files ek sath bhejo
━━━━━━━━━━━━━━━━━━━
"""

ADMIN_HELP_TEXT = """
👑 **Admin Commands:**
━━━━━━━━━━━━━━━━━━━
/all — 🔥 Sab files bhejo
/editmode `<category>` — Forward-to-Add mode ON
/editmode off — Forward-to-Add mode OFF
/add `<category>` `<id1>` `<id2>` ... — Add video IDs
/addrange `<category>` `<start>` `<end>` — Add range of IDs
/remove `<category>` `<id>` — Remove a video ID
/addcategory `<name>` — New category banao
/removecategory `<name>` — Category delete karo
/export — 📤 JSON Data Copy karo
/botstats — Bot statistics
/broadcast `<message>` — Sabko message bhejo
/togglepremium `<category>` — Make category premium/free
/addpremium `<user_id>` — Premium access do
/removepremium `<user_id>` — Premium hatao
/listpremium — Premium users dekho
━━━━━━━━━━━━━━━━━━━
"""

async def help_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    data = load_data()
    user_id = update.effective_user.id
    text = HELP_TEXT
    if is_premium(data, user_id) and not is_admin(user_id):
        text += PREMIUM_HELP_TEXT
    if is_admin(user_id):
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
        await update.message.reply_text("Usage: /addcategory <name>\nExample: /addcategory Threesome\n\n💡 Tip: naam mein 'Premium' rakhoge to vo premium-only category ban jayegi!")
        return

    name = args[0]
    data = load_data()

    if name in data["categories"]:
        await update.message.reply_text(f"⚠️ Category '{name}' already exists!")
        return

    data["categories"][name] = []
    save_data(data)

    premium_note = ""
    if is_premium_category(data, name):
        premium_note = "\n🔒 Ye premium-only category hai — sirf premium users access kar payenge!"

    await update.message.reply_text(
        f"✅ Category **{name}** created!{premium_note}\n\n"
        f"Ab videos add karo: /add {name} <id1> <id2> ...",
        parse_mode="Markdown"
    )

# /togglepremium Solo
async def togglepremium_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await admin_check(update):
        return

    args = context.args
    if len(args) != 1:
        await update.message.reply_text("Usage: /togglepremium <category>\nExample: /togglepremium Solo")
        return

    name = args[0]
    data = load_data()

    if name not in data["categories"]:
        await update.message.reply_text(f"❌ Category '{name}' nahi mili.")
        return

    if "premium_categories" not in data:
        data["premium_categories"] = []

    if name in data["premium_categories"]:
        data["premium_categories"].remove(name)
        status = "🆓 FREE"
    else:
        data["premium_categories"].append(name)
        status = "💎 PREMIUM (Locked for free users)"

    save_data(data)
    await update.message.reply_text(f"✅ Category **{name}** is now **{status}**!", parse_mode="Markdown")

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

# =============================
# PREMIUM MANAGEMENT (Admin)
# =============================

# /addpremium 123456789
async def addpremium_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await admin_check(update):
        return

    if not context.args:
        await update.message.reply_text("Usage: /addpremium <user_id>\nExample: /addpremium 123456789")
        return

    data = load_data()
    if "premium_users" not in data:
        data["premium_users"] = []

    added = 0
    already = 0
    invalid = 0
    for arg in context.args:
        try:
            uid = int(arg)
            if uid in data["premium_users"]:
                already += 1
            else:
                data["premium_users"].append(uid)
                added += 1

                # Notify the user they got premium
                try:
                    await context.bot.send_message(
                        chat_id=uid,
                        text=(
                            "🎉🎉🎉\n\n"
                            "**💎 Congratulations! You're now a Premium user!**\n\n"
                            "Ab tumhe milega:\n"
                            f"• 📤 Unlimited files per request\n"
                            f"• 📅 Unlimited daily access\n"
                            "• 🔓 Premium exclusive categories\n"
                            "• ✅ /all command access\n\n"
                            "Enjoy! /start se shuru karo 🚀"
                        ),
                        parse_mode="Markdown"
                    )
                except Exception:
                    pass  # User may have not started the bot yet
        except ValueError:
            invalid += 1

    save_data(data)

    text = f"✅ Premium updated!\n• Added: {added}\n• Already premium: {already}"
    if invalid:
        text += f"\n• Invalid IDs: {invalid}"
    await update.message.reply_text(text)

# /removepremium 123456789
async def removepremium_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await admin_check(update):
        return

    if not context.args:
        await update.message.reply_text("Usage: /removepremium <user_id>")
        return

    data = load_data()
    if "premium_users" not in data:
        data["premium_users"] = []

    removed = 0
    not_found = 0
    for arg in context.args:
        try:
            uid = int(arg)
            if uid in data["premium_users"]:
                data["premium_users"].remove(uid)
                removed += 1

                # Notify user
                try:
                    await context.bot.send_message(
                        chat_id=uid,
                        text="⚠️ Tumhara Premium access expire ho gaya hai.\n\n💎 Renew karne ke liye admin se contact karo!"
                    )
                except Exception:
                    pass
            else:
                not_found += 1
        except ValueError:
            pass

    save_data(data)
    await update.message.reply_text(f"✅ Removed: {removed}\n❌ Not found: {not_found}")

# /listpremium
async def listpremium_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await admin_check(update):
        return

    data = load_data()
    premium = data.get("premium_users", [])

    if not premium:
        await update.message.reply_text("💎 Koi premium users nahi hain abhi.")
        return

    lines = [f"💎 **Premium Users ({len(premium)}):**\n"]
    for i, uid in enumerate(premium, 1):
        stats = data["user_stats"].get(str(uid), {})
        total_req = stats.get("total_requests", 0)
        lines.append(f"{i}. `{uid}` — {total_req} requests")

    await update.message.reply_text("\n".join(lines), parse_mode="Markdown")

# =============================
# /publish — NOTIFY NEW CONTENT
# =============================

async def publish_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await admin_check(update):
        return

    data = load_data()

    # Build content summary
    cat_summary = ""
    total_files = 0
    for cat, ids in data["categories"].items():
        total_files += len(ids)
        premium_tag = " 💎" if is_premium_category(data, cat) else ""
        cat_summary += f"  📂 {cat}{premium_tag}: {len(ids)} files\n"

    # Custom message from admin (optional)
    custom_msg = ""
    if context.args:
        custom_msg = "\n\n📝 " + " ".join(context.args)

    announcement = (
        "🚀🔥 **New Content Update!** 🔥🚀\n"
        "━━━━━━━━━━━━━━━━━━━\n\n"
        f"🎬 **{total_files} Total Files Available!**\n\n"
        f"**Categories:**\n{cat_summary}\n"
        "━━━━━━━━━━━━━━━━━━━"
        f"{custom_msg}\n\n"
        "👉 /start se browse karo!\n"
        "💎 Premium categories ke liye /upgrade dekho!"
    )

    users = data.get("known_users", [])
    sent = 0
    failed = 0

    for uid in users:
        try:
            await context.bot.send_message(
                chat_id=uid,
                text=announcement,
                parse_mode="Markdown"
            )
            sent += 1
        except Exception:
            failed += 1

    await update.message.reply_text(
        f"📢 **Publish Done!**\n"
        f"✅ Sent: {sent}\n"
        f"❌ Failed: {failed}",
        parse_mode="Markdown"
    )

# /botstats
async def botstats_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await admin_check(update):
        return

    data = load_data()
    total_users = len(data.get("known_users", []))
    total_videos = len(get_all_videos(data))
    total_cats = len(data["categories"])
    total_premium = len(data.get("premium_users", []))

    total_requests = sum(s.get("total_requests", 0) for s in data["user_stats"].values())

    cat_info = ""
    for cat, ids in data["categories"].items():
        premium_tag = " 💎" if is_premium_category(data, cat) else ""
        cat_info += f"  📂 {cat}{premium_tag}: {len(ids)} videos\n"

    text = (
        f"👑 **Bot Statistics**\n"
        f"━━━━━━━━━━━━━━━━━\n"
        f"👥 Total Users: **{total_users}**\n"
        f"💎 Premium Users: **{total_premium}**\n"
        f"🆓 Free Users: **{total_users - total_premium}**\n"
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



async def export_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not await admin_check(update):
        return
    data = load_data()
    # Create a nice formatted JSON string just for categories (and maybe premium users)
    export_data = {
        "categories": data.get("categories", {}),
        "premium_categories": data.get("premium_categories", []),
        "premium_users": data.get("premium_users", [])
    }
    json_str = json.dumps(export_data, indent=4)
    
    # Send in chunks if it's too long
    chunk_size = 4000
    try:
        if len(json_str) <= chunk_size:
            await update.message.reply_text(f"📋 **Copy-Paste Data:**\n\n```json\n{json_str}\n```", parse_mode="Markdown")
        else:
            await update.message.reply_text("📋 **Copy-Paste Data (Multiple Parts):**")
            for i in range(0, len(json_str), chunk_size):
                chunk = json_str[i:i+chunk_size]
                await update.message.reply_text(f"```json\n{chunk}\n```", parse_mode="Markdown")
            await update.message.reply_text("✅ Poora data send ho gaya hai. Sabko copy karke merge karlo.")
    except Exception as e:
        await update.message.reply_text(f"⚠️ Error sending export: {e}")

# =============================
# FORWARD-TO-ADD (ADMIN EDIT MODE)
# =============================

async def editmode_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Activate Forward-to-Add mode for a category.
    Usage: /editmode <category name>   →  turn ON
           /editmode off               →  turn OFF
    """
    if not await admin_check(update):
        return

    args = context.args
    if not args:
        current = context.user_data.get("edit_mode_category")
        if current:
            await update.message.reply_text(
                f"⚙️ Edit mode is currently **ON** for: **{current}**\n"
                f"Forward karo ya `/editmode off` type karo.",
                parse_mode="Markdown"
            )
        else:
            await update.message.reply_text(
                "Usage:\n"
                "`/editmode <CategoryName>` — mode ON\n"
                "`/editmode off` — mode OFF\n\n"
                "Example: `/editmode Solo`",
                parse_mode="Markdown"
            )
        return

    if args[0].lower() == "off":
        old_cat = context.user_data.pop("edit_mode_category", None)
        if old_cat:
            await update.message.reply_text(f"✅ Edit mode OFF. **{old_cat}** ke liye forwarding band.", parse_mode="Markdown")
        else:
            await update.message.reply_text("ℹ️ Edit mode already OFF tha.")
        return

    # Multi-word category names (e.g. /editmode Premium Solo)
    category = " ".join(args)
    data = load_data()

    if category not in data["categories"]:
        cats = "\n".join(f"• `{c}`" for c in data["categories"].keys())
        await update.message.reply_text(
            f"❌ Category **{category}** nahi mili.\n\n"
            f"Available categories:\n{cats}\n\n"
            f"Nayi banane ke liye: `/addcategory {category}`",
            parse_mode="Markdown"
        )
        return

    context.user_data["edit_mode_category"] = category
    count = len(data["categories"][category])
    await update.message.reply_text(
        f"✅ **Edit Mode ON** — **{category}** ({count} files)\n\n"
        f"Ab channel se koi bhi video/photo/file yahan forward karo — "
        f"main automatically ID add kar doonga!\n\n"
        f"**/editmode off** likhoge to mode band ho jayega.",
        parse_mode="Markdown"
    )


async def handle_forward(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Intercept forwarded messages from admins in Edit Mode and auto-add their IDs."""
    user_id = update.effective_user.id
    message = update.message

    # Only process if admin is in edit mode
    if not is_admin(user_id):
        return
    edit_category = context.user_data.get("edit_mode_category")
    if not edit_category:
        return

    origin = message.forward_origin
    if origin is None:
        return

    # Check that the forward came from the configured channel
    if not isinstance(origin, MessageOriginChannel):
        await message.reply_text(
            "⚠️ Ye message channel se forward nahi hua.\n"
            f"Sirf **{CHANNEL_ID}** channel se forward karo.",
            parse_mode="Markdown"
        )
        return

    if origin.chat.id != CHANNEL_ID:
        await message.reply_text(
            f"⚠️ Wrong channel! Ye ID **{origin.chat.id}** se aaya.\n"
            f"Tumhara channel ID: `{CHANNEL_ID}`",
            parse_mode="Markdown"
        )
        return

    msg_id = origin.message_id
    data = load_data()

    if edit_category not in data["categories"]:
        await message.reply_text(f"❌ Category **{edit_category}** ab exist nahi karta. `/editmode off` karo.", parse_mode="Markdown")
        return

    if msg_id in data["categories"][edit_category]:
        await message.reply_text(f"⚠️ ID `{msg_id}` already **{edit_category}** mein hai!", parse_mode="Markdown")
        return

    data["categories"][edit_category].append(msg_id)
    save_data(data)
    total = len(data["categories"][edit_category])
    await message.reply_text(
        f"✅ Added `{msg_id}` → **{edit_category}**\n📊 Total: {total} files",
        parse_mode="Markdown"
    )

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
app_bot.add_handler(CommandHandler("upgrade", upgrade_cmd))
app_bot.add_handler(CommandHandler("search", search_cmd))

# Admin commands
app_bot.add_handler(CommandHandler("add", add_cmd))
app_bot.add_handler(CommandHandler("addrange", addrange_cmd))
app_bot.add_handler(CommandHandler("remove", remove_cmd))
app_bot.add_handler(CommandHandler("togglepremium", togglepremium_cmd))
app_bot.add_handler(CommandHandler("addcategory", addcategory_cmd))
app_bot.add_handler(CommandHandler("removecategory", removecategory_cmd))
app_bot.add_handler(CommandHandler("botstats", botstats_cmd))
app_bot.add_handler(CommandHandler("broadcast", broadcast_cmd))
app_bot.add_handler(CommandHandler("publish", publish_cmd))
app_bot.add_handler(CommandHandler("addpremium", addpremium_cmd))
app_bot.add_handler(CommandHandler("removepremium", removepremium_cmd))
app_bot.add_handler(CommandHandler("listpremium", listpremium_cmd))
app_bot.add_handler(CommandHandler("export", export_cmd))

# Button & text handlers
app_bot.add_handler(CommandHandler("editmode", editmode_cmd))
app_bot.add_handler(CallbackQueryHandler(button_handler))
# Forward-to-Add handler (admin edit mode) — must be before TEXT handler
app_bot.add_handler(MessageHandler(filters.FORWARDED & ~filters.COMMAND, handle_forward))
app_bot.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, send_posts))

print("🤖 SmartBot running...")
app_bot.run_polling()