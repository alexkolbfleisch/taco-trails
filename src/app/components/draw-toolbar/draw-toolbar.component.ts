import { Component, input } from '@angular/core';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';
import { FormsModule } from '@angular/forms';
import { MatMenuModule } from '@angular/material/menu';

export interface MenuAction {
    label: string;
    icon?: string;
    action: () => void;
}

export interface DrawToolbarAction {
    icon: string;
    tooltip: string;
    color?: 'primary' | 'accent' | 'warn';
    isActive?: boolean;
    action: () => void;
    menu?: MenuAction[];
}

export interface DrawToolbarInstruction {
    label: string;
    text: string;
}

export interface DrawToolbarToggle {
    label: string;
    tooltip: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
}

@Component({
    selector: 'app-draw-toolbar',
    standalone: true,
    imports: [
        MatExpansionModule,
        MatIconModule,
        MatButtonModule,
        MatTooltipModule,
        TranslateModule,
        FormsModule,
        MatMenuModule,
    ],
    templateUrl: './draw-toolbar.component.html',
    styleUrls: ['./draw-toolbar.component.css'],
})
export class DrawToolbarComponent {
    // Inputs
    headerTitle = input.required<string>();
    helpTooltip = input.required<string>();
    actions = input.required<DrawToolbarAction[]>();
    instructions = input.required<DrawToolbarInstruction[]>();
    toggle = input<DrawToolbarToggle | null>(null);
}
