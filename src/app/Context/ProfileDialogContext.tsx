"use client";

import { createContext, useContext, useState, ReactNode } from "react";
import UserProfileDialog from "@/app/Dashboard/Components/UserProfileDialog";

type ProfileDialogContextType = {
  openProfile: (uid: string) => void;
};

const ProfileDialogContext = createContext<ProfileDialogContextType | undefined>(
  undefined
);

export function ProfileDialogProvider({ children }: { children: ReactNode }) {
  const [openUid, setOpenUid] = useState<string | null>(null);

  return (
    <ProfileDialogContext.Provider value={{ openProfile: setOpenUid }}>
      {children}
      {openUid && (
        <UserProfileDialog
          userId={openUid}
          isOpen={!!openUid}
          onClose={() => setOpenUid(null)}
        />
      )}
    </ProfileDialogContext.Provider>
  );
}

export function useProfileDialog() {
  const ctx = useContext(ProfileDialogContext);
  if (!ctx)
    throw new Error("useProfileDialog must be used within a ProfileDialogProvider");
  return ctx;
}
