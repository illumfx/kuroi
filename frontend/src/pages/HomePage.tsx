import { ReactNode } from "react";

type HomePageProps = {
  children: ReactNode;
};

function HomePage({ children }: HomePageProps) {
  return <>{children}</>;
}

export default HomePage;
