// Emoji names in a clip title, shown as the stash page shows them: :rocket: is 🚀.
//
// The stash page's table lives in src/views/markdown.js. This is the same table, because the popup cannot load the
// page's scripts: it has to work offline, and its content security policy only allows the extension's own files.
// test/emoji-names.test.js keeps the two identical, so a name cannot be added on one side and quietly missed on the
// other. Only what is shown is converted — the stored title, Copy and the search keep what was typed.
(function () {
    'use strict';

    const EMOJI = {
        zero: '0️⃣', one: '1️⃣', two: '2️⃣', three: '3️⃣',
        four: '4️⃣', five: '5️⃣', six: '6️⃣', seven: '7️⃣',
        eight: '8️⃣', nine: '9️⃣', ten: '🔟', hundred: '💯',
        rocket: '🚀', tada: '🎉', sparkles: '✨', sparkle: '❇️',
        fire: '🔥', zap: '⚡', boom: '💥', white_check_mark: '✅',
        heavy_check_mark: '✔️', ballot_box_with_check: '☑️', x: '❌', warning: '⚠️',
        information_source: 'ℹ️', exclamation: '❗', grey_exclamation: '❕', question: '❓',
        grey_question: '❔', rotating_light: '🚨', construction: '🚧', bug: '🐛',
        hammer_and_wrench: '🛠️', wrench: '🔧', hammer: '🔨', gear: '⚙️',
        lock: '🔒', unlocked: '🔓', key: '🔑', shield: '🛡️',
        closed_lock_with_key: '🔐', bulb: '💡', memo: '📝', spiral_note: '🗒️',
        page_facing_up: '📄', page_with_curl: '📃', clipboard: '📋', books: '📚',
        book: '📖', bookmark: '🔖', pushpin: '📌', round_pushpin: '📍',
        paperclip: '📎', link: '🔗', mag: '🔍', bell: '🔔',
        no_bell: '🔕', loudspeaker: '📢', mega: '📣', speech_balloon: '💬',
        email: '📧', envelope: '✉️', calendar: '📅', date: '📆',
        hourglass: '⌛', hourglass_flowing_sand: '⏳', alarm_clock: '⏰', stopwatch: '⏱️',
        clock1: '🕐', clock2: '🕑', clock3: '🕒', clock4: '🕓',
        clock5: '🕔', clock6: '🕕', clock7: '🕖', clock8: '🕗',
        clock9: '🕘', clock10: '🕙', clock11: '🕚', clock12: '🕛',
        wave: '👋', smile: '😄', grinning: '😁', joy: '😂',
        rofl: '🤣', sweat_smile: '😅', slightly_smiling_face: '🙂', heart_eyes: '😍',
        sunglasses: '😎', partying_face: '🥳', thinking_face: '🤔', facepalm: '🤦',
        eyes: '👀', see_no_evil: '🙈', sob: '😭', angry: '😠',
        scream: '😱', sleeping: '😴', pray: '🙏', muscle: '💪',
        clap: '👏', thumbsup: '👍', '+1': '👍', thumbsdown: '👎',
        '-1': '👎', point_right: '👉', point_left: '👈', point_up: '☝️',
        point_down: '👇', raised_hands: '🙌', ok_hand: '👌', v: '✌️',
        metal: '🤘', fist: '✊', crossed_fingers: '🤞', shrug: '🤷',
        brain: '🧠', package: '📦', computer: '💻', desktop_computer: '🖥️',
        iphone: '📱', robot: '🤖', floppy_disk: '💾', cd: '💿',
        file_folder: '📁', open_file_folder: '📂', bar_chart: '📊', chart_with_upwards_trend: '📈',
        chart_with_downwards_trend: '📉', moneybag: '💰', dollar: '💵', credit_card: '💳',
        coffee: '☕', beer: '🍺', pizza: '🍕', apple: '🍎',
        sunny: '☀️', cloud: '☁️', umbrella: '☔', snowflake: '❄️',
        star: '⭐', star2: '🌟', heart: '❤️', broken_heart: '💔',
        red_circle: '🔴', large_blue_circle: '🔵', large_green_circle: '🟢', black_circle: '⚫',
        white_circle: '⚪', arrow_right: '➡️', arrow_left: '⬅️', arrow_up: '⬆️',
        arrow_down: '⬇️', arrows_counterclockwise: '🔄', recycle: '♻️', infinity: '♾️',
        no_entry: '⛔', no_entry_sign: '🚫', do_not_litter: '🚯', trophy: '🏆',
        medal_sports: '🏅', '1st_place_medal': '🥇', dart: '🎯', goal_net: '🥅',
        triangular_flag_on_post: '🚩', checkered_flag: '🏁', shipit: '🐿️', heavy_plus_sign: '➕',
        heavy_minus_sign: '➖', heavy_multiplication_x: '✖️', heavy_division_sign: '➗', ok: '🆗',
        new: '🆕', free: '🆓', top: '🔝', soon: '🔜'
    };

    function emojiFor(name) {
        const key = String(name || '').toLowerCase();
        return Object.prototype.hasOwnProperty.call(EMOJI, key) ? EMOJI[key] : null;
    }

    // The :names: in a title shown as the emoji themselves; a name that is not known stays as it was typed
    function shortcodes(text) {
        return String(text ?? '').replace(/:([a-z0-9+-][a-z0-9_+-]*):/gi, (all, name) => emojiFor(name) || all);
    }

    const api = { shortcodes, EMOJI };
    globalThis.StashlyEmoji = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
