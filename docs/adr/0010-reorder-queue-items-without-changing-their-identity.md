# Keep explicit queue priority separate from item identity

An admin can move a waiting item to the first or last logical position without replacing its Telegram messages or resetting its queue age. Keep identity, content, credits, and issues attached to the item, refuse movement while an operation owns it, and continue publishing the earliest ready item even when an issue is at the front. This deliberately permits logical publishing order to differ from both enqueue chronology and physical channel order, while renewal retains the chosen position.
