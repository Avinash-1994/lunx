import { create } from 'zustand';

export const useCartStore = create((set) => ({
  items: [],
  add: (item) => set((state) => ({ items: [...state.items, item] }))
}));

export const useUserStore = create((set) => ({
  user: null,
  login: (u) => set({ user: u })
}));

export const useNotificationStore = create((set) => ({
  message: '',
  setMsg: (m) => set({ message: m })
}));
